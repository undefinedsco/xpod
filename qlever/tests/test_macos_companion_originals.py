import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT=Path(__file__).resolve().parents[1]/'scripts/macos_companion_originals.py'
spec=importlib.util.spec_from_file_location('companion',SCRIPT)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class CompanionOriginalsTest(unittest.TestCase):
    def test_actual_installed_binary_recipe_terms_and_receipt_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();cellar=root/'Cellar';keg=cellar/'sample/1.0';runtime=root/'runtime'
            (keg/'lib').mkdir(parents=True);(keg/'.brew').mkdir();(runtime/'lib').mkdir(parents=True)
            (keg/'lib/libsample.dylib').write_bytes(b'installed dylib')
            (runtime/'lib/libsample.dylib').write_bytes(b'relocated dylib')
            (keg/'INSTALL_RECEIPT.json').write_text('{"poured_from_bottle":true}')
            (keg/'.brew/sample.rb').write_text('url "https://example.invalid/source.tar.gz"')
            (keg/'LICENSE').write_text('actual license bytes')
            raw=f'    cp -n "{keg}/lib/libsample.dylib" "{runtime}/lib/libsample.dylib"\n'
            result=module.collect(raw,cellar,runtime,root/'originals')
            self.assertEqual(len(result['bindings']),1);self.assertEqual(len(result['files']),4)
            self.assertEqual(result['bindings'][0]['installedOriginal']['sha256'],module.sha(keg/'lib/libsample.dylib'))
            self.assertNotEqual(result['bindings'][0]['installedOriginal']['sha256'],result['bindings'][0]['member']['sha256'])
            self.assertIn('binary-transformation-reproduction-unverified',result['bindings'][0]['pending'])
            self.assertFalse(result['releaseAccepted'])
            with patch.object(module,'BUDGET',1):
                with self.assertRaisesRegex(ValueError,'budget'):module.collect(raw,cellar,runtime,root/'overbudget')
            self.assertEqual((root/'originals/kegs/sample/1.0/LICENSE').read_text(),'actual license bytes')
    def test_escape_duplicate_missing_companion_and_budget_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();cellar=root/'Cellar';runtime=root/'runtime'
            cellar.mkdir();(runtime/'lib').mkdir(parents=True)
            (runtime/'lib/libx.dylib').write_bytes(b'x')
            for raw in [f'cp -n /outside/x "{runtime}/lib/libx.dylib"',
                        f'cp -n "{cellar}/x/1/lib/x" "{runtime}/../escape"','']:
                with self.assertRaises(ValueError):module.collect(raw,cellar,runtime,root/str(len(list(root.iterdir()))))
            raw=f'cp -n "{cellar}/x/1/lib/x" "{runtime}/lib/libx.dylib"'
            with self.assertRaisesRegex(ValueError,'Duplicate'):module.parse_copy_commands(raw+'\n'+raw,cellar,runtime)
    def test_original_symlink_outside_cellar_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();cellar=root/'Cellar';keg=cellar/'sample/1';runtime=root/'runtime'
            (keg/'lib').mkdir(parents=True);(runtime/'lib').mkdir(parents=True)
            (root/'outside').write_bytes(b'not controlled');(keg/'lib/x').symlink_to(root/'outside')
            (runtime/'lib/x').write_bytes(b'output')
            raw=f'cp -n "{keg}/lib/x" "{runtime}/lib/x"'
            with self.assertRaises(ValueError):module.collect(raw,cellar,runtime,root/'out')

if __name__=='__main__':unittest.main()
