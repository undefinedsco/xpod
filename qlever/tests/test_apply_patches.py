import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "qlever/scripts/apply-patches.py"


class ApplyPatchesScriptTest(unittest.TestCase):
    def test_cli_requires_an_explicit_qlever_source(self):
        result = subprocess.run(
            ["python3", str(SCRIPT), "--help"],
            cwd=ROOT,
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--source", result.stdout)


if __name__ == "__main__":
    unittest.main()
