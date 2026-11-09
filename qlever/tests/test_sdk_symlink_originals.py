import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('symlinks_test',ROOT/'qlever/scripts/sdk-symlink-originals.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class SymlinkOriginalsTest(unittest.TestCase):
    def fixture(self,root):
        first=root/'first.h';first.write_bytes(b'same bytes')
        second=root/'second.h';second.write_bytes(b'same bytes')
        link=root/'alias.h';link.symlink_to(first.name)
        return first,second,link
    def test_original_readlink_and_target_identity_survive_serialization(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();first,second,link=self.fixture(root)
            before=module.observe([link],{},lambda:None)
            module.save(root/'before.json',before)
            value=json.loads((root/'before.json').read_text())['links'][0]
            self.assertEqual(base64.b64decode(value['readlinkBase64']),b'first.h')
            self.assertEqual(value['resolvedTarget'],str(first))
            self.assertEqual(module.compare(before,module.observe([link],{},lambda:None),[link]),[])
    def test_rebinding_to_other_candidate_with_identical_bytes_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();first,second,link=self.fixture(root)
            before=module.observe([first,second,link],{},lambda:None)
            link.unlink();link.symlink_to(second.name)
            with self.assertRaisesRegex(ValueError,'differs from before'):
                module.compare(before,module.observe([link],{},lambda:None),[link])
    def test_same_link_target_text_recreated_link_and_replaced_target_rejected(self):
        for action in ['recreate-link','replace-target']:
            with tempfile.TemporaryDirectory() as directory:
                root=Path(directory).resolve();first,second,link=self.fixture(root)
                before=module.observe([link],{},lambda:None)
                if action=='recreate-link':link.unlink();link.symlink_to(first.name)
                else:second.replace(first)
                with self.assertRaisesRegex(ValueError,'differs from before'):
                    module.compare(before,module.observe([link],{},lambda:None),[link])
    def test_removed_link_and_after_only_link_do_not_mint_before_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();first,second,link=self.fixture(root)
            before=module.observe([link],{},lambda:None)
            link.unlink();link.write_bytes(b'same bytes')
            with self.assertRaisesRegex(ValueError,'removed during compile'):
                module.compare(before,module.observe([link],{},lambda:None),[link])
            link.unlink();link.symlink_to(first.name)
            pending=module.compare({},module.observe([link],{},lambda:None),[link])
            self.assertEqual(pending[0]['reason'],'symlink-original-unavailable-before-compile')
    def test_parent_directory_alias_and_intermediate_link_observed(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();real=root/'real';real.mkdir();(real/'header.h').write_bytes(b'header')
            middle=root/'middle';middle.symlink_to(real.name,target_is_directory=True)
            alias=root/'include';alias.symlink_to(middle.name,target_is_directory=True)
            records=module.observe([alias/'header.h'],{},lambda:None)
            self.assertEqual(set(records),{str(middle),str(alias)})
            middle.unlink();middle.mkdir();(middle/'header.h').write_bytes(b'header')
            with self.assertRaises(ValueError):module.compare(records,module.observe([alias/'header.h'],{},lambda:None),[alias/'header.h'])

if __name__=='__main__':unittest.main()
