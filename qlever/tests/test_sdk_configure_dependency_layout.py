"""Exercise the actual production function without starting SDK acquisition."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'scripts/sdk-inner-materials.py'
MODULE = Path(__file__).resolve().parents[1] / 'scripts' / 'sdk-inner-materials.py'

_MODULE_CACHE = {}

def production_module():
    """Load the REAL module, not an extracted single function.

    `configure_inputs` dispatches to `_makefile_depends` and `file_api`, which are
    module-level bindings. Compiling the one function into a fresh namespace drops
    them and raises NameError, so this fixture must bind the actual module exactly
    as production does. Importing is safe: the module only parses argv under its
    own ``__main__`` guard.
    """
    if 'module' in _MODULE_CACHE:
        return _MODULE_CACHE['module']
    spec = importlib.util.spec_from_file_location('sdk_inner_materials_fixture', MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _MODULE_CACHE['module'] = module
    return module

def production_function():
    return production_module().configure_inputs

class ConfigureDependencies(unittest.TestCase):
    def setUp(self):
        parent = Path(__file__).resolve().parents[2] / '.test-data/sdk-configure-dependency-layout'
        parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=parent)
        self.root = Path(self.temporary.name)
        self.file = self.root / 'CMakeFiles/Makefile.cmake'
        self.file.parent.mkdir()
        self.input = self.root / 'CMake input.txt'; self.input.write_text('actual input')
        self.configure = production_function()
    def tearDown(self): self.temporary.cleanup()
    def text(self, closing='  )'):
        return 'set(CMAKE_MAKEFILE_DEPENDS\n  "CMake input.txt"\n' + closing + '\n'
    def test_actual_generator_indented_close(self):
        self.file.write_text(self.text())
        self.assertEqual(self.configure(self.root), {self.file, self.input})
    def test_prior_unindented_close(self):
        self.file.write_text(self.text(')'))
        self.assertEqual(self.configure(self.root), {self.file, self.input})
    def test_duplicate_blocks_reject(self):
        self.file.write_text(self.text() + self.text())
        with self.assertRaises(ValueError): self.configure(self.root)
    def test_missing_input_reject(self):
        self.file.write_text(self.text()); self.input.unlink()
        with self.assertRaisesRegex(ValueError, 'input original missing'): self.configure(self.root)
    def test_unclosed_block_reject(self):
        self.file.write_text(self.text().replace('  )', ''))
        with self.assertRaises(ValueError): self.configure(self.root)
    def test_noncommand_substring_reject(self):
        self.file.write_text('# ' + self.text())
        with self.assertRaises(ValueError): self.configure(self.root)
    def test_record_bound_reject(self):
        self.file.write_bytes(b'x' * (8*1024**2 + 1))
        with self.assertRaisesRegex(ValueError, 'record budget'): self.configure(self.root)

if __name__ == '__main__': unittest.main()
