import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

SCRIPT=Path(__file__).resolve().parents[1]/'scripts/sdk-command-materials.py'
spec=importlib.util.spec_from_file_location('sdk_commands',SCRIPT)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class SdkCommandMaterialsTest(unittest.TestCase):
    def test_actual_command_wait_and_two_closed_streams(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'input').write_bytes(b'actual input')
            original=module.ref(root/'input',root)
            stage=module.capture('tiny-test',[sys.executable,'-c','import sys;sys.stdout.write("out");sys.stderr.write("err")'],root,root,[original],timeout=5)
            self.assertEqual((root/stage['stdout']['path']).read_bytes(),b'out')
            self.assertEqual((root/stage['stderr']['path']).read_bytes(),b'err')
            receipt=json.loads((root/stage['receipt']['path']).read_text())
            supervision=json.loads((root/stage['supervisionReceipt']['path']).read_text())
            self.assertTrue(receipt['actualWait']);self.assertTrue(supervision['ownedGroupAbsentAfterWait'])
            self.assertEqual(receipt['exit'],0);self.assertEqual(receipt['pgid'],supervision['pgid'])
    def test_failure_retains_originals_and_cannot_return_success_stage(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            with self.assertRaises(RuntimeError):module.capture('tiny-fail',[sys.executable,'-c','import sys;sys.stderr.write("actual failure");sys.exit(7)'],root,root,timeout=5)
            receipt=json.loads((root/'stages/tiny-fail/command.receipt.json').read_text())
            self.assertEqual(receipt['exit'],7)
            self.assertEqual((root/'stages/tiny-fail/stderr.raw').read_text(),'actual failure')
    def test_input_mutation_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'input').write_text('before');original=module.ref(root/'input',root)
            (root/'input').write_text('after')
            with self.assertRaisesRegex(ValueError,'changed'):module.capture('input-check',[sys.executable,'-c','pass'],root,root,[original],timeout=5)
if __name__=='__main__':unittest.main()
