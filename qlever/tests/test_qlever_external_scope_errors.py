"""Error contract driven through the ACTUAL Observer.capture_link_metadata.

No reimplementation of expected_oserror and no copied re-raise logic: a minimal
unprivileged harness supplies exactly the attributes the method touches, the
absolute-operand reader is replaced with a fixed pathname, and the PRE-SCOPE
os.stat is monkeypatched to raise the ORIGINAL sentinel. The method itself must
let TimeoutError (errno None) and EIO escape unchanged, before any emit/window,
and must treat only ENOENT as absent.
"""
import errno
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'qlever' / 'tests'))
if __package__:
    from . import test_qlever_owned_metadata_observer as base
else:
    import test_qlever_owned_metadata_observer as base

backend = base.load('scope_error_backend', 'sdk-ptrace-execution.py')


class _Harness:
    """Minimal backend exposing ONLY the surface capture_link_metadata uses."""

    def __init__(self, build, operand):
        self.build = build
        self.operand = operand
        self.emitted = []
        self.seq = 0
        self.tasks = {7: {'entry': {'sequence': 11},
                          'linkMetadata': dict(model=backend.LINK_MODEL,
                                               form='unlink', entryArch=0xc000003e,
                                               entryNr=87, newDirfd=None,
                                               newPathAddress=0x1000,
                                               oldDirfd=None, oldPathAddress=None,
                                               flags=0)}}
        self.exclusive = None
        self.retained = set()
        self.lifetime_by_identity = {}
        self.timespec_originals = {}
        # the real methods the production method calls
        self.barrier = lambda: {'sequence': 12}

    def emit(self, row):
        self.emitted.append(row)
        self.seq += 1
        return dict(row, sequence=self.seq)


class ExternalScopeErrorContract(unittest.TestCase):
    """Unprivileged: no lease, no ptrace, no fork."""

    def setUp(self):
        self.case = Path(ROOT / '.test-data' / 'scope-errors')
        self.case.mkdir(parents=True, exist_ok=True)
        import tempfile
        self.dir = Path(tempfile.mkdtemp(prefix='case-', dir=str(self.case)))
        self.outside = self.dir / 'outside'          # NOT under build
        self.outside.mkdir()
        self.build = self.dir / 'build'
        self.build.mkdir()
        self.operand = self.outside / 'unit.s'
        self.operand.write_bytes(b'x' * 16)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)

    def _invoke(self, side_effect):
        h = _Harness(str(self.build), str(self.operand))
        self.harness = h
        real_stat = os.stat

        def fake_stat(path, *a, **k):
            if str(path) == str(self.operand):
                raise side_effect
            return real_stat(path, *a, **k)

        real_reader = backend.read_stopped_cstring
        backend.read_stopped_cstring = lambda pid, address, maximum=4096: os.fsencode(str(self.operand))
        os.stat = fake_stat
        try:
            return backend.Observer.capture_link_metadata(h, 7), h
        finally:
            os.stat = real_stat
            backend.read_stopped_cstring = real_reader

    # ---- original sentinel objects must escape unchanged --------------
    def test_caller_timeout_propagates_unchanged_before_any_emit(self):
        sentinel = TimeoutError('actual owned child observation deadline')
        self.assertIsNone(sentinel.errno)
        with self.assertRaises(TimeoutError) as caught:
            self._invoke(sentinel)
        self.assertIs(caught.exception, sentinel)
        self.assertEqual(self.harness.emitted, [],
                         'a deadline must escape before any boundary row')

    def test_eio_propagates_unchanged_before_any_emit(self):
        sentinel = OSError(errno.EIO, 'io error')
        with self.assertRaises(BaseException) as caught:
            self._invoke(sentinel)
        self.assertIs(caught.exception, sentinel, 'an unexpected EIO must escape unchanged')
        self.assertEqual(self.harness.emitted, [])

    def test_enoent_yields_the_unobserved_row(self):
        result = self._invoke(FileNotFoundError(errno.ENOENT, 'absent'))
        row, h = result
        self.assertIsNone(row, 'ENOENT means unobserved, not witnessed')
        self.assertTrue(h.emitted, 'the unobserved boundary row must be emitted')
        self.assertEqual(h.emitted[-1]['kind'], 'link-metadata-unobserved')

    def test_parent_symlink_swap_cannot_admit_an_unleased_inode(self):
        # Real parent-directory redirection preserves the leased A inode while
        # making the second stat/open resolve to a different, unleased B inode.
        first = self.outside / 'first'
        second = self.outside / 'second'
        first.mkdir(); second.mkdir()
        (first / 'unit.s').write_bytes(b'leased A')
        (second / 'unit.s').write_bytes(b'unleased B')
        alias = self.outside / 'alias'
        alias.symlink_to(first, target_is_directory=True)
        self.operand = alias / 'unit.s'
        original_identity = backend.probe.identity(os.stat(self.operand))
        h = _Harness(str(self.build), str(self.operand))
        h.lifetime_by_identity[tuple(original_identity)] = {'token': 'held A'}
        real_stat = os.stat
        seen = []
        def redirect_after_probe(path, *args, **kwargs):
            result = real_stat(path, *args, **kwargs)
            if str(path) == str(self.operand):
                seen.append(backend.probe.identity(result))
                if len(seen) == 1:
                    alias.unlink()
                    alias.symlink_to(second, target_is_directory=True)
            return result
        from unittest.mock import patch
        with patch.object(backend, 'read_stopped_cstring', return_value=os.fsencode(str(self.operand))), patch.object(os, 'stat', side_effect=redirect_after_probe):
            with self.assertRaisesRegex(AssertionError, 'external operand differs'):
                backend.Observer.capture_link_metadata(h, 7)
        self.assertEqual(len(seen), 2)
        self.assertNotEqual(seen[0], seen[1])
        self.assertEqual(backend.probe.identity(real_stat(first / 'unit.s')), original_identity)
        self.assertEqual(h.emitted, [], 'unleased B must receive no args/window witness')
        self.assertEqual(h.retained, set())


if __name__ == '__main__':
    unittest.main()
