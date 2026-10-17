import importlib.util
from pathlib import Path
import tempfile
import tarfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('sdk_inner',ROOT/'qlever/scripts/sdk-inner-materials.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class SdkInnerMaterialsTest(unittest.TestCase):
    def test_only_selected_originals_archived_and_before_bytes_enforced(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();used=root/'used.h';used.write_text('actual header');unused=root/'unused.h';unused.write_text('unselected')
            before={str(used):module.file_identity(used),str(unused):module.file_identity(unused)}
            result=module.archive_inputs([used],root/'materials/domains',before)
            self.assertEqual(len(result['files']),1);self.assertEqual(result['pending'],[])
            with tarfile.open(root/'materials'/result['shards'][0]['path']) as archive:
                self.assertEqual(archive.getnames(),[str(used).lstrip('/')])
            used.write_text('changed')
            with self.assertRaisesRegex(ValueError,'before observation'):module.archive_inputs([used],root/'other/domains',before)
    def test_actual_depfile_records_escaped_paths_and_generated_pending(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();(root/'a.o.d').write_text('a.o: one.h \\\n path\\ with\\ space.h\n')
            self.assertEqual(module.dependency_paths(root),{root/'one.h',root/'path with space.h'})
            generated=root/'generated.h';generated.write_text('generated')
            result=module.archive_inputs([generated],root/'materials/domains',{})
            self.assertEqual(result['pending'][0]['reason'],'generated-or-unobserved-before-compile')
    def test_build_outputs_and_installed_grants_are_not_fake_before_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();obj=root/'built.o';obj.write_bytes(b'compiled output')
            grant=root/'copyright';grant.write_text('installed grant original')
            result=module.archive_inputs([obj,grant],root/'materials/domains',{},[obj],[grant])
            self.assertEqual(result['pending'],[])
            self.assertEqual({row['role'] for row in result['files']},{'compile-output','installed-metadata'})
    def test_module_docker_uses_actual_material_driver_and_retains_test_receipts(self):
        recipe=(ROOT/'docker/qlever-runtime-sdk/Dockerfile.module-bookworm').read_text()
        self.assertIn('sdk-inner-materials.py build',recipe);self.assertIn('sdk-inner-materials.py linked',recipe)
        self.assertNotIn('module-linked-verification.ok',recipe)
        self.assertIn('linked-inner.json',recipe);self.assertIn('test-runtime.receipt.json',recipe)
if __name__=='__main__':unittest.main()
