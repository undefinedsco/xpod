"""ABI seed copies retain bytes and read permissions under a restrictive umask."""
import hashlib
import importlib.util
import os
import stat
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COLLECTOR = ROOT / 'qlever/scripts/sdk-service-abi-collector.py'


def load_collector():
    spec = importlib.util.spec_from_file_location('abi_collector_seed_perm', COLLECTOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Retained:
    """The minimal retained surface copy_seed actually uses, over a real directory."""

    def __init__(self, out: Path):
        self.out = out
        self.refs = {}
        self.total = 0
        self.budget = self

    def check(self, _cost=0):
        return None

    def reserve(self, amount):
        self.total += amount
        return amount


class AbiSeedPermissions(unittest.TestCase):
    def setUp(self):
        base = ROOT/'.test-data/service-abi-seed-permissions'
        base.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=base)
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name).resolve()
        self.collector = load_collector()

    def _source(self):
        data = b'synthetic ABI seed\n' * 512
        size = len(data)
        src = self.out/'seed.original'
        src.write_bytes(data)
        return dict(path='seed.original', bytes=size,
                    sha256=hashlib.sha256(data).hexdigest()), data, src

    def test_seed_copy_preserves_content_and_read_permissions_under_umask(self):
        previous = os.umask(0o077)
        try:
            ref, data, src = self._source()
            retained = _Retained(self.out)
            retained.refs[ref['path']] = ref
            scratch = self.out/'xpod-service-output-0123456789abcdef0123456789abcdef-scratch'
            scratch.mkdir(mode=0o700)
            destination = scratch/'abi.sqlite'

            before = (stat.S_IMODE(src.stat().st_mode), src.read_bytes())

            self.collector.copy_seed(ref, retained, destination)

            # Bytes and hash are exact, so the copy is a faithful seed.
            self.assertEqual(destination.read_bytes(), data)
            self.assertEqual(hashlib.sha256(destination.read_bytes()).hexdigest(), ref['sha256'])
            self.assertEqual(destination.stat().st_size, ref['bytes'])

            mode = stat.S_IMODE(destination.stat().st_mode)
            self.assertTrue(mode & 0o004, 'other-read required: container uid holds no CAP_DAC_OVERRIDE')
            self.assertFalse(mode & 0o002, 'other-write must never be granted')
            self.assertFalse(mode & 0o020, 'group-write must never be granted')

            # The source original's own mode and bytes are untouched by the copy.
            self.assertEqual((stat.S_IMODE(src.stat().st_mode), src.read_bytes()), before)

            # Quota accounting stayed consistent with the declared size.
            self.assertEqual(retained.total, ref['bytes'])
        finally:
            os.umask(previous)



if __name__ == '__main__':
    unittest.main()
