"""Start an isolated local Companion stack. Ctrl-C stops processes and service containers."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import time
import urllib.request
from bun import ROOT, module
from dev_environment import runtime_environment
from dev_support import lock, prepare, read_json, write_json, source_digest, terminate_process, launch_owned, check_service_ports

os.chdir(ROOT)
stack_lock = lock("dev-stack.lock")
state_path = ROOT / ".local/dev-state.json"
process_identity = subprocess.check_output(["ps", "-p", str(os.getpid()), "-o", "lstart="], text=True).strip()
state = {"status": "starting", "pid": os.getpid(), "identity": process_identity, "services": {}}
env = os.environ.copy()
launcher_keys = {
    "WEB_PORT", "API_PORT", "DATABASE_URL", "COMPANIONS_DATA_DIR", "AGENT_TEST_MODE", "LOCAL_RUNTIME",
    "S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET_FILES", "S3_REGION",
    "SMTP_HOST", "SMTP_PORT", "SMTP_FROM", "SMTP_SECURE", "SMTP_USER", "SMTP_PASSWORD",
}
# Bun loads .env itself; the launcher also needs local-service and workspace settings.
if env.get("COMPANIONS_DEV_LOCAL") != "1" and (ROOT / ".env").exists():
    for line in (ROOT / ".env").read_text().splitlines():
        key, sep, value = line.partition("=")
        if sep and key in launcher_keys:
            env.setdefault(key, value.strip().strip('"').strip("'"))
workspace = hashlib.sha256(str(ROOT).encode()).hexdigest()[:10]
base = int(env.get("CONDUCTOR_PORT", env.get("WEB_PORT", str(4000 + int(workspace[:4], 16) % 2000 * 10))))
env.setdefault("WEB_PORT", env.get("PORT", str(base)) if env.get("PORTLESS_URL") else str(base))
env.setdefault("API_PORT", str(base + 1))
env.setdefault("APP_URL", env.get("PORTLESS_URL", f"http://127.0.0.1:{env['WEB_PORT']}"))
env.setdefault("BETTER_AUTH_URL", env["APP_URL"])
runtime_settings = runtime_environment(ROOT)
env.setdefault("AGENT_TEST_MODE", "0" if read_json(ROOT / ".local/dev-options.json").get("liveModel", runtime_settings.get("DEV_LIVE_MODEL") == "1") else "1")
for key, value in runtime_settings.items():
    if env["AGENT_TEST_MODE"] != "1" or key in {"BOX_API_KEY", "BOX_TEMPLATE", "BOX_MANAGED_TEMPLATE", "LOCAL_RUNTIME"}:
        env.setdefault(key, value)
env.setdefault("LOCAL_RUNTIME", "0")
env.update(BOX_MANAGED_TEMPLATE="0", BOX_MANAGED_TEMPLATE_PUBLISH="0")
env.setdefault("COMPANIONS_DATA_DIR", str(ROOT / ".local"))
data_dir = Path(env["COMPANIONS_DATA_DIR"])
if not data_dir.is_absolute():
    data_dir = ROOT / data_dir
data_dir.mkdir(parents=True, exist_ok=True)
data_dir.chmod(0o700)
# Keep the previous ownership journal intact if an old/foreign service holds a port.
requested_components = env.get("COMPANIONS_DEV_COMPONENTS")
try:
    check_service_ports({name: env[key] for name, key in (("api", "API_PORT"), ("web", "WEB_PORT"))
                         if not requested_components or name in requested_components.split(",")})
except RuntimeError as error:
    raise SystemExit(str(error)) from None
write_json(state_path, state)
bun = module.toolchain()
logs = data_dir / "logs"
logs.mkdir(exist_ok=True, mode=0o700)
log_handles = []
children = []
managed_containers = []
public_services = {}

POSTGRES_IMAGE = "postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"
MINIO_IMAGE = "quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e"
MINIO_CLIENT_IMAGE = "quay.io/minio/mc:RELEASE.2025-04-16T18-13-26Z@sha256:aead63c77f9db9107f1696fb08ecb0faeda23729cde94b0f663edf4fe09728e3"
MAILPIT_IMAGE = "axllent/mailpit:v1.27.8@sha256:6abc8e633df15eaf785cfcf38bae48e66f64beecdc03121e249d0f9ec15f0707"

def bun_command(args):
    return [args[0], "--no-env-file", *args[1:]] if args[0] == bun and env.get("COMPANIONS_DEV_LOCAL") == "1" else args

def run(args, **kwargs):
    return subprocess.run(bun_command(args), check=True, env=env, timeout=90, **kwargs)

def container(name):
    found = subprocess.run(["docker", "inspect", name], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10)
    return None if found.returncode else json.loads(found.stdout)[0]

def ensure_container(name, args):
    details = container(name)
    if details is None:
        run(["docker", "run", "--detach", "--name", name,
             "--label", f"companions.build.workspace={workspace}", *args], stdout=subprocess.DEVNULL)
    elif details.get("Config", {}).get("Labels", {}).get("companions.build.workspace") != workspace:
        raise SystemExit("Local service ownership mismatch: " + name)
    elif not details["State"]["Running"]:
        run(["docker", "start", name], stdout=subprocess.DEVNULL)
    managed_containers.append(name)

def wait_http(url, label):
    for _ in range(60):
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status < 500:
                    return
        except Exception:
            time.sleep(0.5)
    raise RuntimeError(f"{label} did not become ready")

def service_credentials():
    path = data_dir / "dev-services.json"
    if path.exists():
        value = json.loads(path.read_text())
        if isinstance(value.get("minioUser"), str) and isinstance(value.get("minioPassword"), str):
            return value
        raise SystemExit(f"Invalid local service credentials in {path}")
    value = {"minioUser": f"companions-{workspace}", "minioPassword": secrets.token_urlsafe(32)}
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value))
    temporary.chmod(0o600)
    temporary.replace(path)
    return value

def stop(*_):
    for child in children:
        terminate_process(child, grace=5)
    # Runtime containers use the data-directory hash; services use the checkout hash.
    clean = True
    for owner in {workspace, hashlib.sha256(str(data_dir.resolve()).encode()).hexdigest()[:10]}:
        selected = subprocess.run(["docker", "ps", "-q", "--filter", f"label=companions.build.workspace={owner}"], capture_output=True, text=True)
        if selected.returncode:
            clean = False
        elif selected.stdout.split():
            result = subprocess.run(["docker", "stop", "--time", "3", *selected.stdout.split()], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            clean = clean and result.returncode == 0
        remaining = subprocess.run(["docker", "ps", "-q", "--filter", f"label=companions.build.workspace={owner}"], capture_output=True, text=True)
        clean = clean and remaining.returncode == 0 and not remaining.stdout.strip()
    for handle in log_handles:
        handle.close()
    if env.get("PORTLESS_URL"):
        from dev_portless import cleanup_stale
        try:
            cleanup_stale(env)
        except RuntimeError as error:
            clean = False
            print(str(error), file=sys.stderr)
    for service in state["services"].values():
        service["status"] = "stopped"
    state.update(status="stopped" if clean and not state.get("failure") else "failed", cleanup={"verified": clean})
    write_json(state_path, state)

signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
run(["docker", "info"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

try:
    postgres_name = f"companions-pg-{workspace}"
    if "DATABASE_URL" not in env:
        ensure_container(postgres_name, [
            "--publish", f"127.0.0.1:{base+2}:5432",
            "--env", "POSTGRES_USER=companions", "--env", "POSTGRES_PASSWORD=companions",
            "--env", "POSTGRES_DB=companions", "--volume", f"{postgres_name}:/var/lib/postgresql/data",
            POSTGRES_IMAGE,
        ])
        database_address = subprocess.check_output(["docker", "port", postgres_name, "5432/tcp"], text=True).strip()
        env["DATABASE_URL"] = f"postgres://companions:companions@{database_address}/companions"
        for _ in range(60):
            ready = subprocess.run(["docker", "exec", postgres_name, "pg_isready", "-h", "127.0.0.1", "-U", "companions"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if ready.returncode == 0:
                break
            time.sleep(0.5)
        else:
            raise SystemExit("PostgreSQL did not become ready")

    minio_name = f"companions-minio-{workspace}"
    if "S3_ENDPOINT" not in env:
        credentials = service_credentials()
        ensure_container(minio_name, [
            "--publish", f"127.0.0.1:{base+3}:9000", "--publish", f"127.0.0.1:{base+4}:9001",
            "--env", f"MINIO_ROOT_USER={credentials['minioUser']}",
            "--env", f"MINIO_ROOT_PASSWORD={credentials['minioPassword']}",
            "--volume", f"{minio_name}:/data", MINIO_IMAGE,
            "server", "/data", "--console-address", ":9001",
        ])
        env.update({
            "S3_ENDPOINT": f"http://127.0.0.1:{base+3}",
            "S3_ACCESS_KEY_ID": credentials["minioUser"],
            "S3_SECRET_ACCESS_KEY": credentials["minioPassword"],
            "S3_BUCKET_FILES": "companions-files", "S3_REGION": "us-east-1",
        })
        wait_http(f"{env['S3_ENDPOINT']}/minio/health/live", "MinIO")
        run(["docker", "run", "--rm", "--network", f"container:{minio_name}",
             "--env", f"MC_HOST_local=http://{credentials['minioUser']}:{credentials['minioPassword']}@127.0.0.1:9000",
             MINIO_CLIENT_IMAGE, "mb", "--ignore-existing", f"local/{env['S3_BUCKET_FILES']}"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    mailpit_name = f"companions-mailpit-{workspace}"
    if "SMTP_HOST" not in env:
        ensure_container(mailpit_name, [
            "--publish", f"127.0.0.1:{base+5}:1025", "--publish", f"127.0.0.1:{base+6}:8025",
            "--env", "MP_DATABASE=/data/mailpit.db", "--volume", f"{mailpit_name}:/data", MAILPIT_IMAGE,
        ])
        env.update({
            "SMTP_HOST": "127.0.0.1", "SMTP_PORT": str(base + 5),
            "SMTP_FROM": "companions.build <auth@companions.build>",
        })
        wait_http(f"http://127.0.0.1:{base+6}/livez", "Mailpit")

    prepare()
    run([bun, "apps/server/src/migrate.ts"])
    env["COMPANIONS_SCHEMA_PREPARED"] = "1"
    service_commands = {
        "api": ([bun, "apps/server/src/api.ts"], ROOT),
        "executor": ([bun, "apps/server/src/executor.ts"], ROOT),
        "worker": ([bun, "apps/server/src/worker.ts"], ROOT),
        "web": ([bun, "run", "dev", "--host", "127.0.0.1", "--port", env["WEB_PORT"]], ROOT / "apps/web"),
    }
    processes = {}
    service_handles = {}
    log_offsets = {}
    selected_components = env.get("COMPANIONS_DEV_COMPONENTS")
    disabled = set(service_commands) - set(selected_components.split(",")) if selected_components else set()
    def start_services(names=None):
        selected = [name for name in (names or service_commands) if name not in disabled]
        for name in selected:
            if name in processes and processes[name].poll() is None:
                continue
            if processes.get(name) in children:
                children.remove(processes[name])
            args, cwd = service_commands[name]
            old_handle = service_handles.pop(name, None)
            if old_handle:
                old_handle.close()
                if old_handle in log_handles:
                    log_handles.remove(old_handle)
            handle = (logs / f"{name}.log").open("a")
            log_offsets[name] = handle.tell()
            service_handles[name] = handle
            log_handles.append(handle)
            def persist_child(child, record):
                children.append(child)
                processes[name] = child
                state["services"][name] = {"status": "starting", "log": str(logs / f"{name}.log"), **record}
                write_json(state_path, state)
            launch_owned(bun_command(args), persist_child, cwd=cwd, env=env, stdout=handle, stderr=subprocess.STDOUT)
        if "api" in selected:
            wait_http(f"http://127.0.0.1:{env['API_PORT']}/health", "API")
        if "web" in selected:
            wait_http(f"http://127.0.0.1:{env['WEB_PORT']}", "Web")
        for _ in range(120):
            if all(processes[name].poll() is None for name in selected) and all(
                marker in (logs / f"{name}.log").read_bytes()[log_offsets[name]:].decode(errors="replace")
                for name, marker in [("executor", "Executor ready"), ("worker", "Worker ready")] if name in selected
            ):
                for name in selected:
                    state["services"][name]["status"] = "ready"
                return
            exited = [(name, processes[name].poll()) for name in selected if processes[name].poll() is not None]
            if exited:
                name, code = exited[0]
                raise RuntimeError(f"{name} exited during startup (code {code}); see {logs / (name + '.log')}")
            time.sleep(.25)
        raise RuntimeError("Executor/worker readiness timed out")

    start_services()
    if env.get("PORTLESS_URL"):
        from dev_portless import register_services
        # Recovery must know the exact proxy before the first alias side effect.
        state["endpoints"] = {"proxyEnv": {key: env[key] for key in ("PORTLESS_URL", "PORTLESS_PORT", "PORTLESS_HTTPS", "PORTLESS_STATE_DIR", "PORTLESS_SYNC_HOSTS") if key in env}}
        write_json(state_path, state)
        public_services = register_services(env, {"api": int(env["API_PORT"]), "storage": base+4, "s3": base+3, "mailpit": base+6})
    endpoints = {"url": env["APP_URL"], "webPort": int(env["WEB_PORT"]), "apiPort": int(env["API_PORT"]),
                 "mailUrl": public_services.get("mailpit", f"http://127.0.0.1:{base+6}"), "basePort": base,
                 "testMode": env["AGENT_TEST_MODE"] == "1", "dataDir": str(data_dir), "workspace": workspace}
    if public_services:
        endpoints["services"] = public_services
        endpoints["proxyEnv"] = {key: env[key] for key in ("PORTLESS_URL", "PORTLESS_PORT", "PORTLESS_HTTPS", "PORTLESS_STATE_DIR", "PORTLESS_SYNC_HOSTS") if key in env}
    write_json(data_dir / "dev-endpoints.json", endpoints)
    state.update(status="ready", url=env["APP_URL"], endpoints=endpoints)
    write_json(state_path, state)
    print(f"\nCompanions: {env['APP_URL']}\nSign in using the email link.", flush=True)
    if env.get("SMTP_HOST") == "127.0.0.1" and env.get("SMTP_PORT") == str(base + 5):
        print(f"Email: {endpoints['mailUrl']}", flush=True)
    print(flush=True)
    def watched_digest():
        from dev_support import digest
        return digest([*ROOT.glob("apps/server/src/**/*"), *ROOT.glob("packages/**/*"),
                       ROOT / "bun.lock", ROOT / "package.json", ROOT / "scripts/build-agent.ts", *ROOT.glob("scripts/lib/*")])
    infrastructure = {"postgres": postgres_name, "storage": minio_name, "s3": minio_name, "mailpit": mailpit_name}
    links = {"web": env["APP_URL"], "api": f"http://127.0.0.1:{env['API_PORT']}/health",
             "postgres": f"postgresql://127.0.0.1:{base+2}/companions", "storage": f"http://127.0.0.1:{base+4}",
             "s3": f"http://127.0.0.1:{base+3}", "mailpit": f"http://127.0.0.1:{base+6}"}
    links.update(public_services)
    if "api" in public_services:
        links["api"] += "/health"
    control = data_dir / "dev-commands"
    control.mkdir(exist_ok=True, mode=0o700)

    def stop_process(name):
        child = processes.get(name)
        if child:
            terminate_process(child)
        if child in children:
            children.remove(child)
        handle = service_handles.pop(name, None)
        if handle:
            handle.close()
            if handle in log_handles:
                log_handles.remove(handle)
        state["services"].setdefault(name, {})["status"] = "stopped"

    def refresh_state():
        for name in service_commands:
            child = processes.get(name)
            status = state["services"].get(name, {}).get("status", "starting") if child and child.poll() is None else "stopped" if name in disabled else "failed"
            state["services"].setdefault(name, {}).update(status=status)
        for name, url in (("api", f"http://127.0.0.1:{env['API_PORT']}/health"), ("web", f"http://127.0.0.1:{env['WEB_PORT']}")):
            child = processes.get(name)
            if child and child.poll() is None:
                try:
                    with urllib.request.urlopen(url, timeout=.5) as response:
                        healthy = response.status == 200
                except Exception:
                    healthy = False
                state["services"][name]["status"] = "ready" if healthy else "unhealthy"
        owned = [name for name in infrastructure.values() if name in managed_containers]
        result = subprocess.run(["docker", "inspect", *owned], capture_output=True, text=True, timeout=10) if owned else None
        containers = {item["Name"].lstrip("/"): item for item in json.loads(result.stdout)} if result and result.returncode == 0 else {}
        for name, container_name in infrastructure.items():
            if container_name not in managed_containers:
                state["services"][name] = {"status": "external", "managed": False}
                continue
            item = containers.get(container_name, {})
            running = item.get("State", {}).get("Running", False)
            status = "ready" if running else "stopped" if item else "unknown"
            if running:
                try:
                    if name == "postgres":
                        healthy = subprocess.run(["docker", "exec", container_name, "pg_isready", "-h", "127.0.0.1", "-U", "companions"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2).returncode == 0
                    else:
                        url = f"http://127.0.0.1:{base+3}/minio/health/live" if name in ("storage", "s3") else f"http://127.0.0.1:{base+6}/livez"
                        with urllib.request.urlopen(url, timeout=.5) as response:
                            healthy = response.status == 200
                    if not healthy:
                        status = "unhealthy"
                except (OSError, subprocess.TimeoutExpired):
                    status = "unhealthy"
            state["services"][name] = {"status": status, "container": container_name, "managed": True}
        for name in ("api", "executor", "worker"):
            service = state["services"][name]
            if service["status"] in ("ready", "blocked"):
                service["status"] = "ready" if state["services"]["postgres"]["status"] in ("ready", "external") else "blocked"
        for name, url in links.items():
            state["services"][name]["url"] = url
        if state["status"] != "build-failed":
            state["status"] = "ready" if all(item["status"] in ("ready", "external") for item in state["services"].values()) else "degraded"
        state["heartbeat"] = time.time()
        write_json(state_path, state)

    def service_action(action, name):
        if action not in ("start", "stop", "restart") or name not in (*service_commands, *infrastructure):
            raise RuntimeError("Unknown service action")
        if name in infrastructure:
            container_name = infrastructure[name]
            details = container(container_name)
            if container_name not in managed_containers or not details or details.get("Config", {}).get("Labels", {}).get("companions.build.workspace") != workspace:
                raise RuntimeError("Service is external or ownership could not be verified")
            run(["docker", action, *(["--time", "3"] if action in ("stop", "restart") else []), container_name], stdout=subprocess.DEVNULL)
            if action != "stop":
                if name == "postgres":
                    for _ in range(60):
                        if subprocess.run(["docker", "exec", container_name, "pg_isready", "-h", "127.0.0.1", "-U", "companions"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                            break
                        time.sleep(.5)
                    else:
                        raise RuntimeError("PostgreSQL readiness timed out")
                else:
                    wait_http(f"http://127.0.0.1:{base+3}/minio/health/live" if name in ("storage", "s3") else links[name] + "/livez", name)
        else:
            if action in ("stop", "restart"):
                disabled.add(name)
                stop_process(name)
            if action in ("start", "restart"):
                disabled.discard(name)
                if name == "executor":
                    prepare()
                start_services([name])

    def process_commands():
        for path in sorted(control.glob("*.request.json")):
            request = read_json(path)
            result = {"status": "failed", "id": request.get("id")}
            try:
                if request.get("supervisor") != state["pid"] or request.get("identity") != state["identity"]:
                    raise RuntimeError("Supervisor changed; command was not replayed")
                name = request.get("service")
                if name in state["services"]:
                    state["services"][name]["status"] = {"start": "starting", "stop": "stopping", "restart": "restarting"}.get(request.get("action"), "unknown")
                    state["status"] = "changing"
                    write_json(state_path, state)
                service_action(request.get("action"), request.get("service"))
                result["status"] = "passed"
            except (RuntimeError, subprocess.CalledProcessError):
                result["error"] = "Service action failed; inspect service logs. No automatic retry."
                if request.get("service") in state["services"]:
                    state["services"][request["service"]]["status"] = "failed"
            refresh_state()
            write_json(path.with_name(path.name.replace(".request.json", ".result.json")), result)
            path.unlink()

    refresh_state()
    observed = watched_digest()
    while True:
        process_commands()
        refresh_state()
        time.sleep(1)
        if env.get("COMPANIONS_DEV_WATCH", "1") == "0":
            continue
        changed = watched_digest()
        if changed == observed:
            continue
        state["status"] = "restarting"
        write_json(state_path, state)
        # Stop admission before changing the runtime. Durable recovery belongs to the executor.
        for child in children:
            terminate_process(child)
        children.clear()
        for handle in log_handles:
            handle.close()
        log_handles.clear()
        try:
            prepare()
            run([bun, "apps/server/src/migrate.ts"])
            start_services()
            state["status"] = "ready"
        except (subprocess.CalledProcessError, RuntimeError):
            for child in children:
                terminate_process(child, grace=5)
            children.clear()
            state.update(status="build-failed")
            print("Reload failed; watching for the next source edit. See .local/logs and dev-launch.log.", flush=True)
        refresh_state()
        observed = changed
    failed_code = next((child.returncode for child in children if child.returncode is not None), 1)
    raise SystemExit(failed_code or 1)
except KeyboardInterrupt:
    pass
except Exception:
    state["failure"] = "Supervisor failed; inspect .local/dev-launch.log and the service logs."
    raise
finally:
    stop()
