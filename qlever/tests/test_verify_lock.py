import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
QLEVER = ROOT / "qlever"
EXPECTED_COMMIT = "c1708167f6e08c16a639f165df580adc464d9b84"


class QleverLockTest(unittest.TestCase):
    def test_lock_pins_source_and_patch_series_without_backend_metadata(self):
        lock = json.loads((QLEVER / "qlever.lock.json").read_text())
        self.assertEqual(lock["repository"], "https://github.com/ad-freiburg/qlever.git")
        self.assertEqual(lock["commit"], EXPECTED_COMMIT)
        self.assertNotIn("postgresMajor", lock)
        self.assertRegex(lock["patchSeriesSha256"], r"^[0-9a-f]{64}$")

        subprocess.run(
            ["python3", str(QLEVER / "scripts/verify-lock.py")],
            cwd=ROOT,
            check=True,
        )

    def test_verifier_rejects_a_different_source_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=source, check=True)
            (source / "README").write_text("not the pinned QLever source\n")
            subprocess.run(["git", "add", "README"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "fixture"], cwd=source, check=True)

            result = subprocess.run(
                ["python3", str(QLEVER / "scripts/verify-lock.py"), "--source", str(source)],
                cwd=ROOT,
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("QLever source commit mismatch", result.stderr)


if __name__ == "__main__":
    unittest.main()
