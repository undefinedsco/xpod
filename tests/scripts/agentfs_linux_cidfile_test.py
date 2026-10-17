import importlib.util
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('linux_cid_binding', ROOT / 'scripts/agentfs-native-ci/mounted/linux-container-binding.py')
binding = importlib.util.module_from_spec(spec)
spec.loader.exec_module(binding)


class OwnedCidPublicationTests(unittest.TestCase):
    def producer(self, directory, contents, delay=.25):
        cidfile = directory / 'container.cid'
        cidfile.write_text('')
        script = 'import time; from pathlib import Path; time.sleep(%r); Path(%r).write_text(%r)' % (delay, str(cidfile), contents)
        return cidfile, [sys.executable, '-c', script]

    def test_actual_delayed_empty_file_publication_is_not_an_invalid_identity(self):
        parent = ROOT / '.test-data/linux-cidfile-tests'
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as directory, ThreadPoolExecutor(max_workers=1) as pool:
            cidfile, command = self.producer(Path(directory), 'a' * 64 + '\n')
            future = pool.submit(subprocess.run, command, check=True, timeout=5)
            self.assertEqual(binding.wait_owned_cid(cidfile, future, timeout=3), 'a' * 64)
            self.assertEqual(future.result().returncode, 0)

    def test_nonempty_invalid_identity_is_never_accepted(self):
        parent = ROOT / '.test-data/linux-cidfile-tests'
        parent.mkdir(parents=True, exist_ok=True)
        for content in ['a' * 63, 'A' * 64, 'not-a-cid', ' ', '\n', '\t', ' ' + 'a' * 64, 'a' * 64 + '\n\n', 'a' * 64 + '\r\n']:
            with self.subTest(content=content), tempfile.TemporaryDirectory(dir=parent) as directory, ThreadPoolExecutor(max_workers=1) as pool:
                cidfile, command = self.producer(Path(directory), content, delay=0)
                future = pool.submit(subprocess.run, command, check=True, timeout=5)
                future.result()
                with self.assertRaisesRegex(RuntimeError, 'cidfile is invalid'):
                    binding.wait_owned_cid(cidfile, future)

    def test_closed_producer_without_identity_fails_closed(self):
        parent = ROOT / '.test-data/linux-cidfile-tests'
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as directory, ThreadPoolExecutor(max_workers=1) as pool:
            cidfile, command = self.producer(Path(directory), '', delay=0)
            future = pool.submit(subprocess.run, command, check=True, timeout=5)
            future.result()
            with self.assertRaisesRegex(RuntimeError, 'not observed before deadline'):
                binding.wait_owned_cid(cidfile, future)

    def test_empty_file_deadline_never_releases_an_identity(self):
        parent = ROOT / '.test-data/linux-cidfile-tests'
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as directory, ThreadPoolExecutor(max_workers=1) as pool:
            cidfile, command = self.producer(Path(directory), 'a' * 64)
            future = pool.submit(subprocess.run, command, check=True, timeout=5)
            with self.assertRaisesRegex(RuntimeError, 'not observed before deadline'):
                binding.wait_owned_cid(cidfile, future, timeout=0)
            self.assertEqual(future.result().returncode, 0)


if __name__ == '__main__':
    unittest.main()
