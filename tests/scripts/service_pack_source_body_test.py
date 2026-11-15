import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('source_body', ROOT / 'scripts/service-pack-source-body.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

class Tests(unittest.TestCase):
    def test_primary_survives_output_close_failure(self):
        parent = ROOT / '.test-data/service-pack-source-body-cleanup'
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as temporary:
            root = Path(temporary)
            (root / 'package').mkdir()
            actual_open, actual_close, opened = os.open, os.close, []
            def held(*args):
                fd = actual_open(*args)
                opened.append(fd)
                return fd
            primary = ValueError('actual limit failed')
            try:
                with mock.patch.object(helper.os, 'open', side_effect=held), mock.patch.object(helper.resource, 'setrlimit', side_effect=primary), mock.patch.object(helper.os, 'close', side_effect=OSError('close failed')):
                    with self.assertRaises(ValueError) as caught:
                        helper.run(['source-body', str(root), str(root / 'output'), '1024'])
                    self.assertIs(caught.exception, primary)
            finally:
                for fd in opened:
                    actual_close(fd)

    def test_close_failure_without_primary_still_fails(self):
        parent = ROOT / '.test-data/service-pack-source-body-cleanup'
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as temporary:
            root = Path(temporary)
            (root / 'package').mkdir()
            actual_open, actual_close, opened = os.open, os.close, []
            def held(*args):
                fd = actual_open(*args)
                opened.append(fd)
                return fd
            cleanup = OSError('close failed')
            try:
                with mock.patch.object(helper.os, 'open', side_effect=held), mock.patch.object(helper.resource, 'setrlimit'), mock.patch.object(helper.os, 'dup2'), mock.patch.object(helper.os, 'close', side_effect=cleanup), mock.patch.object(helper.os, 'execvp') as execute:
                    with self.assertRaises(OSError) as caught:
                        helper.run(['source-body', str(root), str(root / 'output'), '1024'])
                    self.assertIs(caught.exception, cleanup)
                    execute.assert_not_called()
            finally:
                for fd in opened:
                    actual_close(fd)

class SelectedTests(unittest.TestCase):
    def test_actual_held_nul_list_and_malformed_inputs(self):
        parent = ROOT / '.test-data/service-pack-selected-list'
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as temporary:
            file = Path(temporary) / 'selected'
            raw = b'package/package.json\0package/empty\0package/nested/file\0'
            file.write_bytes(raw)
            fd, observed = helper.selected_list(str(file))
            try:
                self.assertEqual(os.read(fd, len(raw)), raw)
                self.assertEqual(observed['members'], 3)
                self.assertEqual(observed['sha256'], __import__('hashlib').sha256(raw).hexdigest())
            finally:
                os.close(fd)
            for bad in [b'', b'package/package.json', b'package/package.json\0package/package.json\0', b'package/package.json\0../escape\0', b'package/package.json\0package/../escape\0', b'package/package.json\0--option\0', b'package/package.json\0package/\0', b'package/package.json\0package/\xff\0']:
                file.write_bytes(bad)
                with self.assertRaises((ValueError, UnicodeError)):
                    helper.selected_list(str(file))

    def test_fifo_directory_and_symlink_zero_leaf_open(self):
        parent = ROOT / '.test-data/service-pack-selected-list'
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as temporary:
            root = Path(temporary)
            fifo = root / 'fifo'
            os.mkfifo(fifo)
            target = root / 'actual'
            target.write_bytes(b'package/package.json\0')
            link = root / 'link'
            link.symlink_to(target)
            with mock.patch.object(helper.os, 'open') as opened:
                for file in (fifo, root, link):
                    with self.assertRaises(ValueError):
                        helper.selected_list(str(file))
                opened.assert_not_called()


if __name__ == '__main__':
    unittest.main()
