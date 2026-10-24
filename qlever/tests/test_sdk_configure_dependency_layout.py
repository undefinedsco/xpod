"""Exercise the actual production function without starting SDK acquisition."""
import ast
from pathlib import Path
import re
import shlex
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'scripts/sdk-inner-materials.py'
def production_function():
    module = ast.parse(SOURCE.read_text())
    function = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'configure_inputs')
    namespace = dict(Path=Path, re=re, shlex=shlex)
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(SOURCE), 'exec'), namespace)
    return namespace['configure_inputs']

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
