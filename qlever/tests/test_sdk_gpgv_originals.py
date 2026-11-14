"""Real child status/stream custody only; fake gpgv grants no signature trust."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('sdk_gpgv_commands',ROOT/'qlever/scripts/sdk-command-materials.py')
commands=importlib.util.module_from_spec(spec);spec.loader.exec_module(commands)

class GpgvOriginalTests(unittest.TestCase):
    def test_exit_two_is_retained_by_both_waiters_and_never_generalized(self):
        parent=ROOT/'.test-data/sdk-gpgv-originals';parent.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as directory:
            root=Path(directory);binary=root/'gpgv'
            binary.write_text('#!'+sys.executable+'\nimport sys\nprint("[GNUPG:] NEWSIG")\nprint("diagnostic",file=sys.stderr)\nsys.exit(2)\n');binary.chmod(0o755)
            with patch.dict(os.environ,{'PATH':str(root)+os.pathsep+os.environ['PATH']}):
                row=commands.capture_gpgv('fixed-gpgv',root/'keyring',root/'InRelease',root,root)
                actual=json.loads((root/row['receipt']['path']).read_text())
                supervisor=json.loads((root/row['supervisionReceipt']['path']).read_text())
                self.assertEqual((actual['exit'],supervisor['exit']),(2,2))
                self.assertTrue(actual['actualWait'] and supervisor['actualWait'])
                self.assertTrue(supervisor['ownedGroupAbsentAfterWait'])
                self.assertEqual(row['classification'],'unclassified-producer-gpgv-originals')
                self.assertEqual((root/row['stdout']['path']).read_bytes(),b'[GNUPG:] NEWSIG\n')
                self.assertEqual((root/row['stderr']['path']).read_bytes(),b'diagnostic\n')
                with self.assertRaises(RuntimeError):commands.capture('ordinary',['gpgv'],root,root)

if __name__=='__main__':unittest.main()
