"""Public regressions for the non-regular operand decisions of the actual backend.

These drive the REAL ``Observer.capture_metadata`` / ``capture_link_metadata``
methods (plus ``complete_metadata`` for the symlink-follow case) on real
temporary files, directories and symlinks. Only stopped-tracee address reading,
the all-stop barrier and the emit bookkeeping are stubbed - the decision logic,
the ``os.stat``/``os.fstat``/``S_ISREG`` expressions and every identity check stay
the production ones.

Absolute operands with ``timesAddress = 0`` keep this portable: no ptrace, no
kernel deadline, no libc call.
"""
import importlib.util
import os
import shutil
import stat
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    'sdk86_operand_backend', ROOT / 'qlever/scripts/sdk-ptrace-execution.py')
backend = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backend)
bindings = backend.bindings

WORK = ROOT / '.test-data' / 'sdk86-metadata-operands'


def identity(path):
    return list(backend.probe.identity(os.stat(path, follow_symlinks=False)))


class Observer:
    """Minimal real Observer with only stopped-memory/barrier/emit stubbed."""

    def __init__(self, build, paths):
        self.build = str(build)
        self.tasks = {1: dict(stopped=True, exited=False, tgid=1, fdTable=1,
                              entry=dict(sequence=10, nr=88))}
        self.exclusive = None
        self.retained = set()
        self.metadata_states = []
        self.timespec_originals = {}
        self.rows = []
        self._seq = 100
        self._paths = paths

    # --- stubs -----------------------------------------------------------
    def barrier(self):
        return dict(sequence=11, pids=[1])

    def emit(self, row):
        self._seq += 1
        row = dict(row, sequence=self._seq, phase='configure')
        self.rows.append(row)
        return row

    def check(self):
        return None

    def _raw(self, pid, address, maximum=4096):
        return self._paths[address]

    # --- bind the real methods ------------------------------------------
    capture_metadata = backend.Observer.capture_metadata
    complete_metadata = backend.Observer.complete_metadata
    capture_link_metadata = backend.Observer.capture_link_metadata
    args_original = backend.Observer.args_original

    def read_cstring(self, pid, address):
        return self._paths[address]


class Base(unittest.TestCase):
    def setUp(self):
        shutil.rmtree(WORK, ignore_errors=True)
        self.build = WORK / 'build'
        self.build.mkdir(parents=True, exist_ok=True)
        self.addCleanup(shutil.rmtree, WORK, True)

    def observer(self, paths):
        observer = Observer(self.build, paths)
        def cstring(pid, address, maximum=4096):
            return observer._paths[address]   # read the CURRENT mapping
        self._patch(observer, 'read_stopped_cstring', cstring)
        return observer

    def _patch(self, observer, name, fn):
        # The real methods resolve these as module-level functions; bind
        # per-instance only for the stopped-memory read.
        module = backend
        original = getattr(module, name)
        setattr(module, name, fn)
        self.addCleanup(setattr, module, name, original)

    def timestamp_meta(self, path, flags=0, timesAddress=0):
        return dict(model=backend.TIMESTAMP_MODEL, form='path', dirfd=-100,
                    pathAddress=0x1000, timesAddress=timesAddress, flags=flags,
                    entryNr=88, entryArch=0xc00000b7)


class TimestampOperands(Base):
    def test_directory_utimensat_is_honestly_unobserved(self):
        directory = self.build / 'tsdir'
        directory.mkdir()
        observer = self.observer({0x1000: os.fsencode(str(directory))})
        observer.tasks[1]['metadataPath'] = self.timestamp_meta(directory)
        self.assertIsNone(observer.capture_metadata(1))
        kinds = [row['kind'] for row in observer.rows]
        self.assertIn('timestamp-target-unobserved', kinds)
        self.assertNotIn('actual-timestamp-window', kinds)
        self.assertFalse(observer.retained)

    def test_regular_file_utimensat_is_captured(self):
        target = self.build / 'plain.tmp'
        target.write_bytes(b'gen')
        observer = self.observer({0x1000: os.fsencode(str(target))})
        observer.tasks[1]['metadataPath'] = self.timestamp_meta(target)
        row = observer.capture_metadata(1)
        self.assertEqual(row['kind'], 'actual-timestamp-window')
        self.assertEqual(row['beforeIdentity'], identity(target))
        self.assertEqual(row['path'], str(target))

    def test_symlink_utimensat_follows_and_keeps_the_real_endpoint(self):
        target = self.build / 'follow.tmp'
        target.write_bytes(b'gen')
        link = self.build / 'follow.link'
        os.symlink(target, link)
        observer = self.observer({0x1000: os.fsencode(str(link))})
        observer.tasks[1]['metadataPath'] = self.timestamp_meta(link)
        row = observer.capture_metadata(1)
        # flags==0 follows: the endpoint must be the REGULAR TARGET, never the
        # symlink and never an "unobserved" record.
        self.assertEqual(row['kind'], 'actual-timestamp-window')
        self.assertEqual(row['beforeIdentity'], identity(target))
        self.assertEqual(row['path'], str(link))
        self.assertNotEqual(row['beforeIdentity'], identity(link))

    def test_symlink_follow_endpoint_survives_the_real_timestamp_change(self):
        target = self.build / 'mutate.tmp'
        target.write_bytes(b'gen')
        link = self.build / 'mutate.link'
        os.symlink(target, link)
        observer = self.observer({0x1000: os.fsencode(str(link))})
        observer.tasks[1]['metadataPath'] = self.timestamp_meta(link)
        row = observer.capture_metadata(1)
        before = row['beforeIdentity']
        # the REAL mutation, through the symlink, on the regular target
        os.utime(link, ns=(1700000000123456789, 1700000000123456789))
        observer.exclusive = (1, 10)
        observer.tasks[1]['metadataWindow'] = observer.tasks[1]['metadataWindow']
        observer.complete_metadata(1, dict(sequence=10), dict(sequence=12, result=0, isError=False))
        kinds = [r['kind'] for r in observer.rows]
        self.assertIn('actual-timestamp-transition', kinds)
        after = [r for r in observer.rows if r['kind'] == 'actual-timestamp-transition'][0]['afterIdentity']
        self.assertEqual(after[4], 1700000000123456789)
        self.assertNotEqual(after[5], before[5], 'ctime must advance on a real write')


class LinkOperands(Base):
    def link_meta(self, form, path, oldPath=None, flags=0):
        return dict(model=backend.LINK_MODEL, form=form,
                    newDirfd=None, newPathAddress=None, oldDirfd=None,
                    oldPathAddress=None, flags=flags, entryNr=0, entryArch=0xc00000b7)

    def test_unlinkat_at_removedir_is_honestly_unobserved(self):
        directory = self.build / 'builddir'
        directory.mkdir()
        observer = self.observer({})
        meta = dict(model=backend.LINK_MODEL, form='unlinkat',
                    newDirfd=None, newPathAddress=None, oldDirfd=None,
                    oldPathAddress=None, flags=0x200, entryNr=263,
                    entryArch=0xc00000b7)
        observer.tasks[1]['linkMetadata'] = meta
        # absolute destination through the same resolver the method uses
        observer._paths = {0x2000: os.fsencode(str(directory))}
        meta['newPathAddress'] = 0x2000
        self.assertIsNone(observer.capture_link_metadata(1))
        kinds = [row['kind'] for row in observer.rows]
        self.assertIn('link-metadata-unobserved', kinds)
        self.assertNotIn('actual-link-window', kinds)

    def test_unlink_of_a_symlink_is_honestly_unobserved(self):
        target = self.build / 'real.tmp'
        target.write_bytes(b'gen')
        link = self.build / 'link.tmp'
        os.symlink(target, link)
        before_links = os.stat(target).st_nlink
        observer = self.observer({})
        meta = dict(model=backend.LINK_MODEL, form='unlink',
                    newDirfd=None, newPathAddress=0x3000, oldDirfd=None,
                    oldPathAddress=None, flags=0, entryNr=87, entryArch=0xc00000b7)
        observer.tasks[1]['linkMetadata'] = meta
        observer._paths = {0x3000: os.fsencode(str(link))}
        self.assertIsNone(observer.capture_link_metadata(1))
        self.assertIn('link-metadata-unobserved', [r['kind'] for r in observer.rows])
        self.assertEqual(os.stat(target).st_nlink, before_links,
                         'unlinking a symlink never changes the target nlink')

    def test_regular_unlink_is_captured(self):
        target = self.build / 'gone.tmp'
        target.write_bytes(b'gen')
        observer = self.observer({})
        meta = dict(model=backend.LINK_MODEL, form='unlink',
                    newDirfd=None, newPathAddress=0x4000, oldDirfd=None,
                    oldPathAddress=None, flags=0, entryNr=87, entryArch=0xc00000b7)
        observer.tasks[1]['linkMetadata'] = meta
        observer._paths = {0x4000: os.fsencode(str(target))}
        row = observer.capture_link_metadata(1)
        self.assertEqual(row['kind'], 'actual-link-window')
        self.assertEqual(row['beforeIdentity'], identity(target))
