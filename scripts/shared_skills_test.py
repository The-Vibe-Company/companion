"""Check shared skill packaging and artifact preparation in isolated Git repositories."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / ".agents/skills"
PACKAGES = ('better-ui', 'capture-learning-tools', 'design-frontend-dev', 'emil-design-eng', 'grilling', 'plan-pr', 'review-code-dev', 'ship-pr-dev', 'tdd')
PREPARERS = {
    "ship-pr-dev": "prepare_ship_run.py",
    "review-code-dev": "prepare_review_run.py",
}


def git(repo, *args):
    # Fixture repositories must not invoke a contributor's signing UI or global hooks.
    env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
    return subprocess.run(["git", "-C", str(repo), *args], env=env, check=True, text=True, capture_output=True).stdout.strip()


class SharedSkillsTests(unittest.TestCase):
    def test_packages_and_claude_links_are_self_contained(self):
        for name in PACKAGES:
            with self.subTest(skill=name):
                package = SKILLS / name
                manifest = json.loads((package / "companion.json").read_text())
                self.assertEqual(name, manifest["name"])
                self.assertTrue((package / "SKILL.md").is_file())
                for dependency, skill_id in manifest["dependencies"].items():
                    dependency_manifest = json.loads((SKILLS / dependency / "companion.json").read_text())
                    self.assertEqual(skill_id, dependency_manifest["metadata"]["companionSkillId"])
                link = ROOT / ".claude/skills" / name
                self.assertTrue(link.is_symlink())
                self.assertFalse(link.readlink().is_absolute())
                self.assertEqual(package.resolve(), link.resolve())
        for name in ("better-ui", "emil-design-eng"):
            with self.subTest(link=name):
                link = ROOT / ".claude/skills" / name
                self.assertTrue(link.is_symlink())
                self.assertFalse(link.readlink().is_absolute())
                self.assertEqual((SKILLS / name).resolve(), link.resolve())
        self.assertTrue((SKILLS / "design-frontend-dev/LICENSE").is_file())

    def test_v2_package_contract_and_compatibility_helpers(self):
        ship = SKILLS / "ship-pr-dev"
        review = SKILLS / "review-code-dev"
        self.assertEqual("1.6.0", json.loads((ship / "companion.json").read_text())["version"])
        manifest = json.loads((review / "companion.json").read_text())
        self.assertEqual("2.1.0", manifest["version"])
        self.assertEqual({}, manifest["dependencies"])
        self.assertEqual({}, manifest["environment"]["secrets"])
        self.assertIn("Apache License", (review / "LICENSE").read_text())
        for filename in ("ocr.py", "test_ocr.py", "prepare_review_run.py",
                         "collect_review_context.py", "test_collect_review_context.py"):
            self.assertTrue((review / "scripts" / filename).is_file(), filename)
        for obsolete in ("agents", "references", "evals", "scripts/parse_review_findings.py",
                         "scripts/veille_pr_state.py", "scripts/test_veille_pr_state.py"):
            self.assertFalse((review / obsolete).exists(), obsolete)
        gate = (ship / "references/review-gate.md").read_text()
        for contract in ("2.0.0", "(scope, path, status)", "workspace", "merge base",
                         "explicit human acceptance", "after every later commit/push"):
            self.assertIn(contract, gate)
        skill = (review / "SKILL.md").read_text()
        self.assertIn("git diff <merge_base>..<to>", skill)
        self.assertIn("(path, status)", skill)
        for name in ("ship-pr-dev", "review-code-dev"):
            self.assertEqual([], list((SKILLS / name).rglob("__pycache__")))
            self.assertEqual([], list((SKILLS / name).rglob("*.pyc")))

    def test_bundled_python_suites(self):
        for name in PACKAGES:
            for test in sorted((SKILLS / name / "scripts").glob("test_*.py")):
                with self.subTest(test=test.name):
                    subprocess.run([sys.executable, "-B", str(test)], check=True, capture_output=True, text=True)

    def test_preparation_in_checkout_and_worktree(self):
        for name, script in PREPARERS.items():
            for worktree in (False, True):
                for ignored in (False, True):
                    with self.subTest(skill=name, worktree=worktree, ignored=ignored), tempfile.TemporaryDirectory() as temp:
                        root = Path(temp)
                        repo = root / "repo"
                        repo.mkdir()
                        git(repo, "init", "-q")
                        git(repo, "config", "user.name", "Skill Test")
                        git(repo, "config", "user.email", "skill-test@example.invalid")
                        (repo / ".gitignore").write_text(f"/plans/{name}/\n" if ignored else "# test\n")
                        git(repo, "add", ".gitignore")
                        git(repo, "commit", "-qm", "test fixture")
                        checkout = root / "worktree" if worktree else repo
                        if worktree:
                            git(repo, "worktree", "add", "--detach", str(checkout))
                        exclude = Path(git(checkout, "rev-parse", "--git-path", "info/exclude"))
                        if not exclude.is_absolute():
                            exclude = checkout / exclude
                        exclude_before = exclude.read_bytes()
                        status_before = git(checkout, "status", "--porcelain")
                        # Run outside the target repository to exercise explicit --cwd resolution.
                        result = subprocess.run(
                            [sys.executable, str(SKILLS / name / "scripts" / script), "--cwd", str(checkout)],
                            cwd=root, check=True, capture_output=True, text=True,
                        )
                        metadata = json.loads(result.stdout)
                        run_dir = Path(metadata["run_dir"])
                        self.assertTrue(run_dir.is_relative_to(checkout.resolve()))
                        self.assertTrue((run_dir / "run-metadata.json").is_file())
                        git(checkout, "check-ignore", "-q", str(run_dir / "run-metadata.json"))
                        self.assertEqual(status_before, git(checkout, "status", "--porcelain"))
                        if ignored:
                            self.assertEqual(exclude_before, exclude.read_bytes())
                        else:
                            self.assertIn(f"/plans/{name}/", exclude.read_text().splitlines())

    def test_tracked_artifacts_are_rejected_before_writing(self):
        for name, script in PREPARERS.items():
            with self.subTest(skill=name), tempfile.TemporaryDirectory() as temp:
                repo = Path(temp)
                git(repo, "init", "-q")
                artifact = repo / "plans" / name / "existing.md"
                artifact.parent.mkdir(parents=True)
                artifact.write_text("tracked fixture\n")
                (repo / ".gitignore").write_text(f"/plans/{name}/\n")
                git(repo, "add", "-f", str(artifact))
                exclude = repo / ".git/info/exclude"
                before = exclude.read_bytes()
                result = subprocess.run(
                    [sys.executable, str(SKILLS / name / "scripts" / script), "--cwd", str(repo)],
                    capture_output=True, text=True,
                )
                self.assertNotEqual(0, result.returncode)
                self.assertIn("tracked", result.stderr)
                self.assertFalse((artifact.parent / "runs").exists())
                self.assertEqual(before, exclude.read_bytes())


if __name__ == "__main__":
    unittest.main()
