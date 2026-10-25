"""Bounded-original reader: exact-size allocation with the full refusal set intact.

Repo-relative; no absolute /Users paths, no .test-data dependency. These cases pass
with the fixed readers and fail on the old read(cap+1) shape only where the
allocation, not the returned bytes, differs - so the allocation cases guard the
regression while the behaviour cases guard the contract.
"""
import importlib.util
import os
import pathlib
import shutil
import sys
import tempfile
import io
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SCRIPTS = HERE.parent / 'scripts'


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, str(SCRIPTS / filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


origin = _load('test_link_origin', 'link_command_origin.py')
reader_module = _load('test_bounded_reader', 'bounded-original-reader.py')
file_api = _load('test_cmake_file_api', 'cmake_file_api.py')


class BoundedOriginalBytes(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def write(self, name, data):
        path = os.path.join(self.directory, name)
        with open(path, 'wb') as handle:
            handle.write(data)
        return path

    def test_static_bytes_are_returned_exactly(self):
        path = self.write('a.json', b'{"a":1}')
        self.assertEqual(origin.bounded_original_bytes(path, 4 << 20, origin.OriginInvalid),
                         b'{"a":1}')

    def test_empty_original_is_allowed(self):
        path = self.write('empty.json', b'')
        self.assertEqual(origin.bounded_original_bytes(path, 4 << 20, origin.OriginInvalid), b'')

    def test_page_boundary_size_is_returned_exactly(self):
        data = b'y' * (4096 * 3)
        path = self.write('page.json', data)
        self.assertEqual(origin.bounded_original_bytes(path, 4 << 20, origin.OriginInvalid), data)

    def test_exactly_the_limit_is_allowed(self):
        data = b'x' * (4 << 20)
        path = self.write('at.json', data)
        self.assertEqual(len(origin.bounded_original_bytes(path, 4 << 20, origin.OriginInvalid)),
                         len(data))

    def test_over_the_limit_is_refused_before_allocation(self):
        path = self.write('over.json', b'x' * ((4 << 20) + 1))
        with self.assertRaises(origin.OriginInvalid):
            origin.bounded_original_bytes(path, 4 << 20, origin.OriginInvalid)

    def test_symlink_is_refused(self):
        target = self.write('real.json', b'{}')
        link = os.path.join(self.directory, 'link.json')
        os.symlink(target, link)
        with self.assertRaises(origin.OriginInvalid):
            origin.bounded_original_bytes(link, 4 << 20, origin.OriginInvalid)

    def test_directory_is_refused(self):
        with self.assertRaises(origin.OriginInvalid):
            origin.bounded_original_bytes(self.directory, 4 << 20, origin.OriginInvalid)

    def test_missing_original_raises_the_caller_error_not_success(self):
        with self.assertRaises(origin.OriginInvalid):
            origin.bounded_original_bytes(os.path.join(self.directory, 'absent.json'),
                                          4 << 20, origin.OriginInvalid)


class FileApiReaderKeepsItsOwnContract(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def test_static_and_boundary_and_limits(self):
        path = os.path.join(self.directory, 'a.json')
        with open(path, 'wb') as handle:
            handle.write(b'{"a":1}')
        self.assertEqual(file_api._bounded_read(path), b'{"a":1}')
        with open(path, 'wb') as handle:
            handle.write(b'x' * (file_api.MEMBER_LIMIT + 1))
        with self.assertRaises(file_api.FileApiUnavailable):
            file_api._bounded_read(path)

    def test_symlink_and_directory_refused_with_its_own_error(self):
        target = os.path.join(self.directory, 'r.json')
        with open(target, 'wb') as handle:
            handle.write(b'{}')
        link = os.path.join(self.directory, 'l.json')
        os.symlink(target, link)
        with self.assertRaises(file_api.FileApiUnavailable):
            file_api._bounded_read(link)
        with self.assertRaises(file_api.FileApiUnavailable):
            file_api._bounded_read(self.directory)


class SingleImplementation(unittest.TestCase):
    """The three call sites must share one algorithm, not three copies."""

    def test_helper_is_importable_without_siblings(self):
        self.assertTrue(callable(reader_module.read_bounded_original))
        self.assertTrue(callable(reader_module.identity))

    def test_no_module_keeps_its_own_cap_plus_one_read(self):
        """Assert on CODE, not prose: no module may call read(<LIMIT> + 1)."""
        import ast
        for name in ('cmake_file_api.py', 'link_command_adapter.py',
                     'link_command_origin.py'):
            tree = ast.parse((SCRIPTS / name).read_text())
            offenders = []
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                func = node.func
                if not (isinstance(func, ast.Attribute) and func.attr in ('read', 'readline')):
                    continue
                for arg in node.args:
                    if (isinstance(arg, ast.BinOp) and isinstance(arg.op, ast.Add)
                            and isinstance(arg.right, ast.Constant) and arg.right.value == 1):
                        offenders.append(name)
            self.assertEqual(offenders, [], 'cap+1 read survives in ' + name)

    def test_missing_helper_is_a_hard_import_error_not_a_fallback(self):
        """The loader must raise for an absent sibling; it must not degrade."""
        loader = getattr(origin, '_load_sibling', None)
        self.assertIsNotNone(loader, 'origin must expose the sibling loader')
        with self.assertRaises(ImportError):
            loader('absent_probe', 'definitely-absent-reader.py')


class AllocationIsSizedFromFstat(unittest.TestCase):
    """This is the regression guard: the OLD reader asked for cap+1 bytes and let
    CPython shrink, which is what glibc turns into mremap(MAYMOVE). The fixed reader
    must ask for exactly the verified length."""

    def setUp(self):
        self.directory = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def test_only_the_exact_size_is_requested(self):
        data = b'{"a":1}'
        path = os.path.join(self.directory, 'a.json')
        with open(path, 'wb') as handle:
            handle.write(data)

        requested = []
        real_open = io.open

        class Recording(io.FileIO):
            def read(self, size=-1):
                requested.append(size)
                return super().read(size)

        def spy(file, mode='r', *args, **kwargs):
            if mode == 'rb' and os.path.abspath(file) == os.path.abspath(path):
                return Recording(file, mode)
            return real_open(file, mode, *args, **kwargs)

        import builtins
        original = builtins.open
        builtins.open = spy
        try:
            got = origin.bounded_original_bytes(path, 4 << 20, origin.OriginInvalid)
        finally:
            builtins.open = original

        self.assertEqual(got, data)
        self.assertIn(len(data), requested,
                      'reader must request exactly the verified size')
        self.assertNotIn((4 << 20) + 1, requested,
                         'reader must not request the 4 MiB cap (mremap regression)')
        self.assertTrue(all(size <= len(data) for size in requested if size >= 0),
                        'no read may exceed the real file size: ' + repr(requested))


if __name__ == '__main__':
    unittest.main()
