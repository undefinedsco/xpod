"""Real ownership byte retention and root-prefix wiring; no Debian origin claim."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'qlever/scripts'/file);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
hook=load('binary_hook_test','sdk-debian-binary-hook.py')
commands=load('binary_hook_commands','sdk-command-materials.py')

class OwnershipTests(unittest.TestCase):
    def setUp(self):
        self.parent=ROOT/'.test-data/sdk-debian-binary-hook';self.parent.mkdir(parents=True,exist_ok=True)
    def test_actual_original_bytes_and_exact_shape(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            root=Path(directory);info=root/'info';info.mkdir();out=root/'out';out.mkdir()
            source=info/'cmake:arm64.list';source.write_bytes(b'/usr/bin/cmake\n')
            with patch.object(hook,'INFO_ROOT',info):
                rows,size=hook.preserve_ownership(out,[source,source],lambda:1024,commands.ref,lambda:None)
            self.assertEqual(size,len(source.read_bytes()));self.assertEqual(len(rows),1)
            self.assertEqual(rows[0]['originalPath'],str(source))
            self.assertEqual(rows[0]['original']['path'],'ownership-originals/cmake:arm64.list')
            self.assertEqual((out/rows[0]['original']['path']).read_bytes(),source.read_bytes())
    def test_insufficient_remaining_rejects_before_original_copy(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            root=Path(directory);info=root/'info';info.mkdir();out=root/'out';out.mkdir();source=info/'cmake.list';source.write_bytes(b'actual')
            with patch.object(hook,'INFO_ROOT',info),self.assertRaisesRegex(ValueError,'byte/type budget'):
                hook.preserve_ownership(out,[source],lambda:0,commands.ref,lambda:None)
            self.assertEqual(list((out/'ownership-originals').iterdir()),[])

if __name__=='__main__':unittest.main()
