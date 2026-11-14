import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT=Path(__file__).resolve().parents[1]/'scripts/macos_dependency_inventory.py'
spec=importlib.util.spec_from_file_location('dependencies',SCRIPT)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class DependencyInventoryTest(unittest.TestCase):
    def test_actual_paths_deduplicate_and_specific_root_wins(self):
        with tempfile.TemporaryDirectory() as directory:
            raw=Path(directory)/'deps.raw';raw.write_text('object: #deps 4\n    /build/_deps/x-src/include/a.h\n    /build/generated.h\n    /SDK/usr/include/a.h\n    /SDK/usr/include/a.h\n')
            result=module.summarize(raw,[('generated','/build'),('source','/build/_deps/x-src'),('sdk','/SDK')])
            self.assertEqual(result['totalUniquePaths'],3)
            self.assertEqual(result['counts'],dict(source=1,generated=1,sdk=1))
            self.assertEqual(result['status'],'dependency-path-observation')
    def test_raw_budget_and_long_line_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            raw=Path(directory)/'deps.raw';raw.write_text('    /SDK/a.h\n')
            with patch.object(module,'MAX_RAW',1):
                with self.assertRaisesRegex(ValueError,'budget'):module.summarize(raw,[])
            raw.write_bytes(b' '*65537)
            with self.assertRaisesRegex(ValueError,'budget'):module.summarize(raw,[])
if __name__=='__main__':unittest.main()
