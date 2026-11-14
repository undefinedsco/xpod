import importlib.util
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT=Path(__file__).resolve().parents[1]/'scripts/observe-macos-native-materials.py'
spec=importlib.util.spec_from_file_location('inventory_order',SCRIPT)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class InventoryOrderTest(unittest.TestCase):
    def test_real_antlr_path_shapes_use_one_canonical_string_order(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'source';source.mkdir()
            for name in ['runtime/CSharp/src/Antlr4.csproj','runtime-testsuite/pom.xml','file.h','file/nested.h']:
                path=source/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(name)
            snapshot=module.snapshot_sources([('engine',source)],root/'kit')
            expected=sorted([row['reference'] for row in snapshot],key=lambda row:row['path'])
            self.assertEqual(module.source_kit_inventory(root/'kit'),expected)
            module.assert_source_inventory(root/'kit',expected)
            # Matching order must still refuse an actual byte change.
            (root/'kit/engine/runtime-testsuite/pom.xml').write_text('different bytes')
            diagnostic=io.StringIO()
            with contextlib.redirect_stderr(diagnostic),self.assertRaises(RuntimeError):module.assert_source_inventory(root/'kit',expected)
            self.assertEqual(json.loads(diagnostic.getvalue())['changed'],['engine/runtime-testsuite/pom.xml'])
if __name__=='__main__':unittest.main()
