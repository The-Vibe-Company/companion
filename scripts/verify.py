"""Run repository checks with isolated services and durable evidence."""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
import re
from pathlib import Path
import secrets
import shlex
import signal
import subprocess
import sys
import time
import urllib.request
import uuid

from bun import ROOT, module
from validation_evidence import source_evidence

POSTGRES_IMAGES = {
    "17": "postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94",
    "18": "postgres@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280",
}
PROFILES = ("web", "server", "agent", "full")
PRIVATE_ENV_NAMES = {
    "AGENT_TOKEN", "APP_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BOX_API_KEY",
    "BOX_TEMPLATE", "COMPANION_BOX_API_KEY", "COMPANIONS_ENCRYPTION_KEY", "COMPANIONS_TOKEN",
    "DATABASE_URL", "EMAIL_PROVIDER",
    "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL", "DEV_LIVE_MODEL", "GOOGLE_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
    "OPENROUTER_API_KEY", "ZAI_API_KEY", "RESEND_API_KEY", "SMTP_HOST", "SMTP_PASSWORD",
    "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
    "MODEL_GATEWAY_URL", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
}


def private_environment(name):
    return name in PRIVATE_ENV_NAMES or name.endswith(("_API_KEY", "_PASSWORD", "_SECRET", "_TOKEN"))


def interrupt_on_signal(number, _frame):
    raise InterruptedError(f"received {signal.Signals(number).name}")


def dependency_fingerprint(paths):
    digest = hashlib.sha256()
    for path in paths:
        digest.update(path.relative_to(ROOT).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
    return digest.hexdigest()


class Verifier:
    def __init__(self, args):
        self.args = args
        self.bun = None
        self.postgres_image = POSTGRES_IMAGES[args.postgres]
        self.run_id = uuid.uuid4().hex[:12]
        self.artifacts = ROOT / ".artifacts/verification" / self.run_id
        self.artifacts.mkdir(parents=True)
        self.artifacts.chmod(0o700)
        self.database_name = f"companions-verify-postgres-{self.run_id}"
        self.database_volume = f"companions-verify-postgres-data-{self.run_id}"
        self.storage_name = f"companions-verify-minio-{self.run_id}"
        self.verification_label = f"companions.build.verification={self.run_id}"
        self.env = {key: value for key, value in os.environ.items() if not private_environment(key)}
        self.env.update({"AGENT_TEST_MODE": "1", "LOCAL_RUNTIME": "1", "COMPANIONS_VERIFY_RUN": self.run_id})
        self.steps = []
        self.started = time.monotonic()
        self.status = "failed"
        self.failure = None
        self.container_diagnostics = []
        self.source_changed = False
        self.backup_sha256 = None
        self.cleanup = {"status": "pending", "containers": {}, "volumes": {}}
        command = [sys.executable, "scripts/verify.py", "--profile", args.profile, "--postgres", args.postgres]
        if args.test:
            command.extend(["--test", args.test])
        self.reproduction = shlex.join(command)
        self.source = source_evidence(ROOT)
        self.publish_latest("running")

    def latest_payload(self, status):
        return {"status": status, "profile": self.args.profile, "run": self.run_id,
            "pid": os.getpid(),
            "artifact": str(self.artifacts.relative_to(ROOT)), "source": self.source,
            "sourceChanged": self.source_changed,
            "reproduction": self.reproduction,
            "updatedAt": datetime.now(timezone.utc).isoformat()}

    def publish_latest(self, status):
        path = ROOT / ".local/latest-validation.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.latest_payload(status), indent=2) + "\n")
        temporary.replace(path)

    def run(self, label, command, cwd=ROOT, timeout=180):
        print(f"[{label}]", flush=True)
        before = time.monotonic()
        log_path = self.artifacts / f"{label}.log"
        step = {"name": label, "status": "running"}
        self.steps.append(step)
        child = None
        child_running = False
        try:
            with log_path.open("w") as log:
                child = subprocess.Popen(command, cwd=cwd, env=self.env, stdout=log,
                    stderr=subprocess.STDOUT, start_new_session=True)
                child_running = True
                try:
                    code = child.wait(timeout=timeout)
                    child_running = False
                except subprocess.TimeoutExpired:
                    self.terminate(child)
                    child_running = False
                    step.update({"status": "failed", "exitCode": None, "timedOut": True,
                                 "timeoutSeconds": timeout})
                    raise RuntimeError(f"{label} timed out after {timeout} seconds")
            step.update({"status": "passed" if code == 0 else "failed", "exitCode": code,
                         "timedOut": False})
            if code:
                print(log_path.read_text(errors="replace")[-8000:])
                raise RuntimeError(f"{label} failed with exit code {code}")
        except BaseException:
            if child is not None and child_running:
                self.terminate(child)
            if step["status"] == "running":
                step["status"] = "failed"
            step.setdefault("exitCode", None)
            step.setdefault("timedOut", False)
            raise
        finally:
            step["seconds"] = round(time.monotonic() - before, 3)

    @staticmethod
    def terminate(child):
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                return
            child.wait()

    def skipped(self, label, reason):
        self.steps.append({"name": label, "status": "skipped", "reason": reason, "seconds": 0})

    def prepare_dependencies(self):
        from dev_support import lock
        with lock('prepare.lock', blocking=True):
            self._prepare_dependencies()

    def _prepare_dependencies(self):
        stamp_path = ROOT / ".local/verification-dependencies.json"
        try:
            stamps = json.loads(stamp_path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            stamps = {}
        changed = False
        targets = []
        if self.args.profile in ("server", "agent", "full"):
            targets.append(("root", ROOT, [ROOT / "package.json", ROOT / "bun.lock"], "install"))
        if self.args.profile in ("web", "full"):
            targets.append(("web", ROOT / "apps/web", [ROOT / "apps/web/package.json", ROOT / "apps/web/bun.lock"], "web-install"))
        for key, cwd, inputs, label in targets:
            fingerprint = dependency_fingerprint(inputs)
            if (cwd / "node_modules").is_dir() and stamps.get(key) == fingerprint:
                self.skipped(label, "lockfiles unchanged")
                continue
            self.run(label, [self.bun, "--no-env-file", "install", "--frozen-lockfile"], cwd)
            stamps[key] = fingerprint
            changed = True
        if changed:
            stamp_path.parent.mkdir(parents=True, exist_ok=True)
            stamp_path.write_text(json.dumps(stamps, indent=2) + "\n")

    def start_services(self):
        self.postgres_data_path = "/var/lib/postgresql" if self.args.postgres == "18" else "/var/lib/postgresql/data"
        self.run("database-volume", ["docker", "volume", "create", "--label", self.verification_label, self.database_volume])
        self.run("database", ["docker", "run", "--detach", "--name", self.database_name,
            "--label", self.verification_label, "--publish", "127.0.0.1::5432",
            "--volume", f"{self.database_volume}:{self.postgres_data_path}",
            "--env", "POSTGRES_USER=companions", "--env", "POSTGRES_PASSWORD=companions",
            "--env", "POSTGRES_DB=companions", self.postgres_image])
        mapping = subprocess.check_output(["docker", "port", self.database_name, "5432/tcp"], text=True).strip()
        self.env["DATABASE_URL"] = f"postgres://companions:companions@{mapping}/companions"
        for _ in range(60):
            if subprocess.run(["docker", "exec", self.database_name, "pg_isready", "-h", "127.0.0.1", "-U", "companions"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                break
            time.sleep(.5)
        else:
            raise RuntimeError("PostgreSQL readiness timed out")

        storage_access_key = f"verify-{self.run_id}"
        storage_secret_key = secrets.token_hex(24)
        self.run("storage", ["docker", "run", "--detach", "--name", self.storage_name,
            "--label", self.verification_label, "--publish", "127.0.0.1::9000",
            "--env", f"MINIO_ROOT_USER={storage_access_key}", "--env", f"MINIO_ROOT_PASSWORD={storage_secret_key}",
            "quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e", "server", "/data"])
        storage_mapping = subprocess.check_output(["docker", "port", self.storage_name, "9000/tcp"], text=True).strip()
        storage_endpoint = f"http://127.0.0.1:{storage_mapping.rsplit(':', 1)[-1]}"
        for _ in range(60):
            try:
                with urllib.request.urlopen(f"{storage_endpoint}/minio/health/live", timeout=.5) as response:
                    if response.status == 200:
                        break
            except Exception:
                pass
            time.sleep(.5)
        else:
            raise RuntimeError("MinIO readiness timed out")
        self.run("storage-bucket", ["docker", "run", "--rm", "--label", self.verification_label,
            "--network", f"container:{self.storage_name}",
            "--env", f"MC_HOST_verify=http://{storage_access_key}:{storage_secret_key}@127.0.0.1:9000",
            "quay.io/minio/mc:RELEASE.2025-04-16T18-13-26Z@sha256:aead63c77f9db9107f1696fb08ecb0faeda23729cde94b0f663edf4fe09728e3",
            "mb", "--ignore-existing", "verify/companions-files"])
        self.env.update({"S3_ENDPOINT": storage_endpoint, "S3_ACCESS_KEY_ID": storage_access_key,
            "S3_SECRET_ACCESS_KEY": storage_secret_key, "S3_BUCKET_FILES": "companions-files", "S3_REGION": "us-east-1"})

    def run_agent_checks(self):
        self.run("agent-unit", [self.bun, "--no-env-file", "test", "packages/plugins/definitions.test.ts", "packages/plugins/tools.test.ts", "packages/agent/test/daemon.test.ts",
            "packages/agent/test/environment.test.ts",
            "packages/agent/test/memory.test.ts", "packages/agent/test/memory-store.test.ts",
            "packages/agent/test/memory-service.test.ts", "packages/agent/test/skills.test.ts",
            "packages/desktop/desktop.test.ts",
            "scripts/live-desktop-canary-wait.test.ts", "scripts/live-box-desktop-wait.test.ts",
] )
        self.run("git-credentials", [self.bun, "--no-env-file", "test", "packages/agent/test/git-credentials.test.ts"])
        # A fresh checkout must not depend on a manually built developer image.
        context = ROOT / "experiments/desktop-boundary"
        image = "companions-distribution-proof:" + dependency_fingerprint(sorted(path for path in context.rglob("*") if path.is_file()))[:16]
        self.run("distribution-image", ["docker", "build", "--platform", "linux/amd64", "--tag", image, str(context)], timeout=300)
        self.env["COMPANIONS_DISTRIBUTION_TEST_IMAGE"] = image
        self.run("distribution-content-linux", [self.bun, "--no-env-file", "scripts/test-distribution-verification.ts"])
        self.run("agent-build", [self.bun, "--no-env-file", "scripts/build-agent.ts"])
        self.run("memory-pi-linux", [self.bun, "--no-env-file", "scripts/test-memory-pi.ts"])

    def run_server_checks(self):
        command = [self.bun, "--no-env-file", "scripts/test-server.ts", "--linux"]
        if self.args.test:
            command.extend(["--test", self.args.test])
        self.run("system", command)

    def run_web_checks(self):
        self.run("web-tests", [self.bun, "--no-env-file", "run", "test"], ROOT / "apps/web")
        self.run("web-build", [self.bun, "--no-env-file", "run", "build"], ROOT / "apps/web")

    def run_restore_check(self):
        restore_state = self.artifacts / "postgres-restore-state.json"
        backup = self.artifacts / "postgres-backup.dump"
        self.env["COMPANIONS_DATA_DIR"] = str(self.artifacts / "postgres-restore-config")
        self.run("postgres-restore-seed", [self.bun, "--no-env-file", "scripts/test-postgres-restore.ts", "seed", str(restore_state)])
        self.run("postgres-backup", ["docker", "exec", self.database_name, "pg_dump", "--username", "companions", "--dbname", "companions", "--format", "custom", "--file", "/tmp/companions.dump"])
        self.run("postgres-backup-copy", ["docker", "cp", f"{self.database_name}:/tmp/companions.dump", str(backup)])
        backup.chmod(0o600)
        self.backup_sha256 = hashlib.sha256(backup.read_bytes()).hexdigest()
        self.run("postgres-crash", ["docker", "kill", self.database_name])
        recovery_name = f"companions-verify-postgres-recovery-{self.run_id}"
        recovery_volume = f"companions-verify-postgres-recovery-data-{self.run_id}"
        self.run("postgres-recovery-volume", ["docker", "volume", "create", "--label", self.verification_label, recovery_volume])
        self.run("postgres-recovery", ["docker", "run", "--detach", "--name", recovery_name,
            "--label", self.verification_label, "--publish", "127.0.0.1::5432",
            "--volume", f"{recovery_volume}:{self.postgres_data_path}", "--env", "POSTGRES_USER=companions",
            "--env", "POSTGRES_PASSWORD=companions", "--env", "POSTGRES_DB=companions", self.postgres_image])
        recovery_mapping = subprocess.check_output(["docker", "port", recovery_name, "5432/tcp"], text=True).strip()
        for _ in range(60):
            if subprocess.run(["docker", "exec", recovery_name, "pg_isready", "-h", "127.0.0.1", "-U", "companions"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                break
            time.sleep(.5)
        else:
            raise RuntimeError("Recovery PostgreSQL readiness timed out")
        self.run("postgres-restore-copy", ["docker", "cp", str(backup), f"{recovery_name}:/tmp/companions.dump"])
        self.run("postgres-restore", ["docker", "exec", recovery_name, "pg_restore", "--exit-on-error", "--username", "companions", "--dbname", "companions", "/tmp/companions.dump"])
        self.env["DATABASE_URL"] = f"postgres://companions:companions@127.0.0.1:{recovery_mapping.rsplit(':', 1)[-1]}/companions"
        self.run("postgres-restore-verify", [self.bun, "--no-env-file", "scripts/test-postgres-restore.ts", "verify", str(restore_state)])

    def execute(self):
        self.bun = module.toolchain()
        self.prepare_dependencies()
        if self.args.profile == "full":
            python_tests = set((ROOT / "scripts").glob("dev-*.test.py"))
            python_tests.update((ROOT / "scripts").glob("*_test.py"))
            for path in sorted(python_tests):
                label = path.name.replace(".test.py", "") if path.name.endswith(".test.py") else path.stem.removesuffix("_test")
                self.run(f"python-{label}", [sys.executable, str(path)])
        if self.args.profile in ("server", "full"):
            self.start_services()
        if self.args.profile in ("server", "agent", "full"):
            self.run("typecheck", [self.bun, "--no-env-file", "node_modules/typescript/bin/tsc"])
        if self.args.profile in ("agent", "full"):
            self.run_agent_checks()
        elif self.args.profile == "server":
            self.run("agent-build", [self.bun, "--no-env-file", "scripts/build-agent.ts"])
        if self.args.profile in ("server", "full"):
            self.run_server_checks()
        if self.args.profile in ("web", "full"):
            self.run_web_checks()
        if self.args.profile == "full":
            self.run_restore_check()
        self.status = "passed"

    def diagnose_owned_resources(self):
        """Keep safe crash facts before cleanup, never container configuration or raw logs."""
        if self.args.profile not in ("server", "agent", "full"):
            return
        try:
            selected = subprocess.run(["docker", "ps", "-aq", "--filter", f"label={self.verification_label}"],
                                      capture_output=True, text=True, timeout=10)
            for identifier in selected.stdout.split() if selected.returncode == 0 else []:
                observed = subprocess.run(["docker", "inspect", "--format", "{{json .State}}", identifier],
                                          capture_output=True, text=True, timeout=10)
                if observed.returncode:
                    continue
                state = json.loads(observed.stdout)
                record = {"container": identifier, **{key: state.get(key) for key in ("Status", "ExitCode", "OOMKilled")}}
                logs = subprocess.run(["docker", "logs", "--tail", "20", identifier], capture_output=True, text=True, timeout=10)
                record["startupCodes"] = [line for line in (logs.stdout + "\n" + logs.stderr).splitlines()
                                          if re.fullmatch(r"STARTUP_[A-Z0-9_]{1,100}", line)]
                self.container_diagnostics.append(record)
                print("Owned container diagnostic: " + json.dumps(record), flush=True)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            print("Owned container diagnostics unavailable; continuing cleanup", flush=True)

    def clean_owned_resources(self):
        if self.args.profile not in ("server", "agent", "full"):
            self.cleanup = {"status": "passed", "containers": {"found": 0, "removed": 0, "remaining": 0},
                            "volumes": {"found": 0, "removed": 0, "remaining": 0}, "errors": []}
            return
        errors = []
        owned = subprocess.run(["docker", "ps", "-aq", "--filter", f"label={self.verification_label}"], text=True, capture_output=True)
        container_ids = owned.stdout.split() if owned.returncode == 0 else []
        self.cleanup["containers"] = {"found": len(container_ids), "removed": 0}
        if owned.returncode:
            errors.append("container discovery failed")
        elif container_ids:
            result = subprocess.run(["docker", "rm", "-f", "-v", *container_ids], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if result.returncode:
                errors.append("container removal failed")
            else:
                self.cleanup["containers"]["removed"] = len(container_ids)
        remaining = subprocess.run(["docker", "ps", "-aq", "--filter", f"label={self.verification_label}"], text=True, capture_output=True)
        self.cleanup["containers"]["remaining"] = len(remaining.stdout.split()) if remaining.returncode == 0 else None
        if remaining.returncode or remaining.stdout.split():
            errors.append("container cleanup postcondition failed")
        volumes = subprocess.run(["docker", "volume", "ls", "-q", "--filter", f"label={self.verification_label}"], text=True, capture_output=True)
        volume_ids = volumes.stdout.split() if volumes.returncode == 0 else []
        self.cleanup["volumes"] = {"found": len(volume_ids), "removed": 0}
        if volumes.returncode:
            errors.append("volume discovery failed")
        elif volume_ids:
            result = subprocess.run(["docker", "volume", "rm", *volume_ids], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if result.returncode:
                errors.append("volume removal failed")
            else:
                self.cleanup["volumes"]["removed"] = len(volume_ids)
        remaining = subprocess.run(["docker", "volume", "ls", "-q", "--filter", f"label={self.verification_label}"], text=True, capture_output=True)
        self.cleanup["volumes"]["remaining"] = len(remaining.stdout.split()) if remaining.returncode == 0 else None
        if remaining.returncode or remaining.stdout.split():
            errors.append("volume cleanup postcondition failed")
        self.cleanup.update({"status": "failed" if errors else "passed", "errors": errors})
        if errors:
            self.status = "failed"

    def write_report(self):
        final_source = source_evidence(ROOT)
        self.source_changed = final_source["fingerprint"] != self.source["fingerprint"]
        if self.source_changed:
            self.status = "failed"
            self.failure = self.failure or {"type": "SourceChanged", "message": "source changed during validation"}
        report = {"status": self.status, "run": self.run_id, "profile": self.args.profile,
            "seconds": round(time.monotonic() - self.started, 3), "source": self.source,
            "sourceChanged": self.source_changed,
            **({"finalSource": final_source} if self.source_changed else {}),
            "reproduction": self.reproduction,
            "postgres": {"major": int(self.args.postgres), "image": self.postgres_image,
                         **({"backupSha256": self.backup_sha256} if self.backup_sha256 else {})},
            "steps": self.steps, "cleanup": self.cleanup, "containerDiagnostics": self.container_diagnostics,
            **({"failure": self.failure} if self.failure else {})}
        (self.artifacts / "summary.json").write_text(json.dumps(report, indent=2) + "\n")
        self.publish_latest(self.status)
        print(f"{self.status.upper()}: {self.artifacts.relative_to(ROOT)}", flush=True)


def parse_args(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", choices=PROFILES, default="full")
    parser.add_argument("--postgres", choices=POSTGRES_IMAGES, default="17", help="PostgreSQL major used for isolated verification")
    parser.add_argument("--test", help="substring selecting server test files")
    args = parser.parse_args(argv)
    if args.test and args.profile != "server":
        parser.error("--test is only valid with the server profile; full always runs every suite")
    return args


def main(argv=None):
    os.chdir(ROOT)
    args = parse_args(argv)
    lock_path = ROOT / ".local/verification.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("ERROR: another validation is already running in this worktree", file=sys.stderr)
            return 2
        verifier = Verifier(args)
        previous_sigterm = signal.getsignal(signal.SIGTERM)
        signal.signal(signal.SIGTERM, interrupt_on_signal)
        try:
            verifier.execute()
        except BaseException as error:
            verifier.failure = {"type": type(error).__name__, "message": str(error)}
            print(f"ERROR: {error}", file=sys.stderr, flush=True)
        finally:
            try:
                if verifier.failure:
                    verifier.diagnose_owned_resources()
            finally:
                verifier.clean_owned_resources()
                verifier.write_report()
                signal.signal(signal.SIGTERM, previous_sigterm)
        return 0 if verifier.status == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
