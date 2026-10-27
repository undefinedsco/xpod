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
import errno
import os
import shutil
import signal
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
        # dispatcher attributes the real event_original reads after the guard
        self.generated_vma = None
        self.capture_toolchain = False
        self.process_authority = False
        self.serialize_terminal_syscalls = False
        self.terminal_exit_evidence = False
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
    settle_absent_link_operand = backend.Observer.settle_absent_link_operand
    pending_captures_original = backend.Observer.pending_captures_original
    resume_original = backend.Observer.resume_original
    args_original = backend.Observer.args_original

    def read_cstring(self, pid, address):
        return self._paths[address]

    def phase_progress(self):
        return None

    # Methods the real dispatcher calls after the settlement guard; the guard
    # under test runs BEFORE these, so stubbing them keeps the test focused.
    def complete_clone3_consumption(self, pid, record):
        return None


class DispatcherObserver(Observer):
    """Observer whose first candidate declines and whose writer is recorded."""

    processed = []

    def capture_metadata(self, pid):
        return None                       # decline: unobserved/out-of-scope target

    def capture_write(self, pid, fd):
        DispatcherObserver.processed.append(('write', pid, fd))
        return dict(kind='actual-write-window', sequence=500)


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

    # --- R2: absence at entry must be settled by a REAL failing exit ----------
    # Architecture honesty: only use (arch, nr) pairs the production table
    # actually declares. x64 has link=86/unlink=87; arm64 declares ONLY
    # linkat=37/unlinkat=35, so the legacy path forms are x64-only.
    def _absent_meta(self, arch, form, nr, path_address=0x5000):
        at = form in ('linkat', 'unlinkat')
        return dict(model=backend.LINK_MODEL, form=form,
                    newDirfd=(-100 if at else None), newPathAddress=path_address,
                    oldDirfd=(-100 if at else None), oldPathAddress=0x5001, flags=0,
                    entryNr=nr, entryArch=arch)

    def test_declared_link_table_forms_map_to_their_own_arch(self):
        """The form must come from the production table for each architecture."""
        for arch, expected in ((0xc000003e, {'link': 86, 'linkat': 265, 'unlink': 87, 'unlinkat': 263}),
                               (0xc00000b7, {'linkat': 37, 'unlinkat': 35})):
            for form, nr in expected.items():
                with self.subTest(arch=hex(arch), form=form):
                    self.assertEqual(backend.link_metadata_form(arch, nr), form)
        # forms the arm64 table never declares must not be inferred
        self.assertIsNone(backend.link_metadata_form(0xc00000b7, 87))

    def test_absent_operand_entry_alone_emits_no_window_for_any_form(self):
        """Entry absence is an OBSERVATION: it must never yield a metadata window."""
        missing = self.build / 'CMakeFiles' / '3.31.6' / 'CompilerIdC'
        for arch, form, nr in ((0xc000003e, 'unlink', 87), (0xc000003e, 'unlinkat', 263),
                               (0xc00000b7, 'unlinkat', 35)):
            with self.subTest(arch=hex(arch), form=form):
                observer = self.observer({})
                observer.tasks[1]['linkMetadata'] = self._absent_meta(arch, form, nr)
                observer._paths = {0x5000: os.fsencode(str(missing)),
                                   0x5001: os.fsencode(str(missing))}
                self.assertIsNone(observer.capture_link_metadata(1))
                kinds = [row['kind'] for row in observer.rows]
                self.assertIn('link-metadata-absent-entry', kinds)
                self.assertNotIn('actual-link-window', kinds,
                                 'entry absence must never fabricate a window')
                self.assertIn('absentLinkOperand', observer.tasks[1])

    def test_absent_link_source_is_also_an_observation_not_a_crash(self):
        """A missing link/linkat SOURCE also fails at the kernel, so it is observed."""
        missing = self.build / 'never.tmp'
        for arch, form, nr in ((0xc000003e, 'link', 86), (0xc000003e, 'linkat', 265),
                               (0xc00000b7, 'linkat', 37)):
            with self.subTest(arch=hex(arch), form=form):
                observer = self.observer({})
                observer.tasks[1]['linkMetadata'] = self._absent_meta(arch, form, nr)
                observer._paths = {0x5000: os.fsencode(str(missing)),
                                   0x5001: os.fsencode(str(missing))}
                self.assertIsNone(observer.capture_link_metadata(1))
                self.assertNotIn('actual-link-window', [r['kind'] for r in observer.rows])

    def test_absent_operand_requires_a_real_negative_errno_at_matching_exit(self):
        """Success, malformed, stale and terminal cases must all fail closed."""
        missing = self.build / 'absent.tmp'

        def captured(observer):
            observer.tasks[1]['linkMetadata'] = self._absent_meta(0xc000003e, 'unlink', 87)
            observer._paths = {0x5000: os.fsencode(str(missing)),
                               0x5001: os.fsencode(str(missing))}
            observer.capture_link_metadata(1)
            marker = observer.tasks[1]['absentLinkOperand']
            # binding must use the marker's OWN recorded entry coordinates
            observer.tasks[1]['entry'] = dict(sequence=marker['entrySequence'],
                                              arch=marker['arch'], nr=marker['nr'],
                                              args=[0, 0, 0, 0, 0, 0])
            return marker

        def settle(observer, is_error, result, mutate=None):
            marker = captured(observer)
            if mutate:
                mutate(marker)
            entry = observer.tasks[1]['entry']
            exit_ = dict(op='exit', result=result, isError=is_error,
                         arch=entry['arch'], entrySequence=entry['sequence'], sequence=8)
            return backend.Observer.settle_absent_link_operand(observer, 1, marker, entry, exit_)

        # a genuinely failing exit is accepted and recorded with the real errno
        observer = self.observer({})
        settle(observer, True, -errno.ENOENT)
        self.assertIn('link-metadata-absent-confirmed',
                      [r['kind'] for r in observer.rows])
        # an unexpected SUCCESS is rejected (the peer-created race)
        observer = self.observer({})
        with self.assertRaises(AssertionError):
            settle(observer, False, 0)
        # malformed result / flag pairs are rejected
        for is_error, result in ((True, 0), (True, 5), (True, -4096), (True, None),
                                 (False, -errno.ENOENT)):
            with self.subTest(is_error=is_error, result=result):
                with self.assertRaises(AssertionError):
                    settle(self.observer({}), is_error, result)
        # stale entry sequence binding is rejected
        with self.assertRaises(AssertionError):
            settle(self.observer({}), True, -errno.ENOENT,
                   mutate=lambda m: m.update(entrySequence=99))
        # wrong declared form for the arch is rejected
        with self.assertRaises(AssertionError):
            settle(self.observer({}), True, -errno.ENOENT,
                   mutate=lambda m: m.update(form='link'))

    # --- R3: the ACTUAL event_original path, not only the helper ------------
    def _dispatched_absent(self, arch=0xc000003e, nr=87):
        """Take a real entry observation, then drive the REAL event_original."""
        missing = self.build / 'dispatched-absent.tmp'
        observer = self.observer({})
        # the task's live entry must carry the SAME arch/nr the marker will bind
        observer.tasks[1]['entry'] = dict(sequence=10, arch=arch, nr=nr, args=[0] * 6)
        observer.tasks[1]['linkMetadata'] = self._absent_meta(arch, 'unlink' if nr == 87 else 'unlinkat', nr)
        observer._paths = {0x5000: os.fsencode(str(missing)),
                           0x5001: os.fsencode(str(missing))}
        self.assertIsNone(observer.capture_link_metadata(1))
        marker = observer.tasks[1]['absentLinkOperand']
        entry = dict(sequence=marker['entrySequence'], arch=marker['arch'],
                     nr=marker['nr'], args=[0] * 6)
        observer.tasks[1]['entry'] = entry
        return observer, marker, entry

    def _drive_exit(self, observer, entry, is_error, result, arch=None):
        """Dispatch a REAL exit record through event_original.

        Only the kernel syscall reader is stubbed (exactly as root did): the
        record it returns is what the real dispatcher parses and settles.
        """
        record = dict(op='exit', arch=entry['arch'] if arch is None else arch,
                      result=result, isError=is_error)
        profile = dict(backend.bindings.policy(record['arch']))
        profile['exit'] = profile['exits']
        real = backend.single.syscall
        backend.single.syscall = lambda pid: (record, profile)
        try:
            # real ptrace syscall-stop encoding: WIFSTOPPED true and
            # WSTOPSIG == (SIGTRAP|0x80), which is what the dispatcher requires
            status = ((signal.SIGTRAP | 0x80) << 8) | 0x7F
            backend.Observer.event_original(observer, 1, status)
        finally:
            backend.single.syscall = real
        return record

    def test_actual_event_path_rejects_success_and_accepts_real_negative(self):
        # success must fail closed through the real dispatcher
        observer, marker, entry = self._dispatched_absent()
        with self.assertRaises(AssertionError):
            self._drive_exit(observer, entry, False, 0)
        # a genuine negative errno settles and is recorded
        observer, marker, entry = self._dispatched_absent()
        self._drive_exit(observer, entry, True, -errno.ENOENT)
        kinds = [r['kind'] for r in observer.rows]
        self.assertIn('link-metadata-absent-confirmed', kinds)

    def test_actual_event_path_rejects_wrong_arch_and_stale_binding(self):
        # wrong-architecture exit must not settle a declared-form observation
        observer, marker, entry = self._dispatched_absent()
        with self.assertRaises(AssertionError):
            self._drive_exit(observer, entry, True, -errno.ENOENT, arch=0xc00000b7)
        # a stale/mismatched marker binding is refused even with a real failure
        observer, marker, entry = self._dispatched_absent()
        observer.tasks[1]['absentLinkOperand']['entrySequence'] = 999
        with self.assertRaises(AssertionError):
            self._drive_exit(observer, entry, True, -errno.ENOENT)

    def test_terminal_exit_with_unresolved_marker_records_wait_before_refusing(self):
        """A task vanishing before the required failing exit is unproven.

        The kernel reaping state must still be recorded: the task is marked
        exited and a wait record is emitted, so a dead task never looks live
        merely because the proof failed.
        """
        observer, marker, entry = self._dispatched_absent()
        observer.terminal_focus = None
        observer.wait_references = []
        observer.current_phase = 'configure'
        observer.root = 1
        released = []
        observer.release_vfork_parent = lambda pid, row, reason: released.append((pid, row['sequence'], reason))
        exit_status = signal.SIGKILL  # actual WIFSIGNALED status, not normal exit(9)
        with self.assertRaisesRegex(AssertionError, 'unresolved at terminal exit'):
            backend.Observer.event_original(observer, 1, exit_status)
        self.assertTrue(observer.tasks[1]['exited'])
        self.assertFalse(observer.tasks[1]['stopped'])
        waits = [row for row in observer.rows if row['kind'] == 'actual-wait-exit']
        self.assertEqual(len(waits), 1)
        self.assertEqual(waits[0]['returnCode'], -signal.SIGKILL)
        self.assertEqual(observer.tasks[1]['actualWaitSequence'], waits[0]['sequence'])
        self.assertEqual(observer.wait_references[0]['sequence'], waits[0]['sequence'])
        self.assertEqual(observer.root_code, -signal.SIGKILL)
        self.assertEqual(released, [(1, waits[0]['sequence'], 'actual-terminal-wait')])
        self.assertIsNone(observer.tasks[1].get('absentLinkOperand'),
                          'the unresolved marker must not survive the refusal')
        self.assertNotIn('link-metadata-absent-confirmed',
                         [r['kind'] for r in observer.rows])

    # --- R3: dispatcher must DRAIN every candidate before any resume --------
    def _dispatcher_observer(self):
        observer = self.observer({})
        setattr(observer, 'barrier', lambda: dict(sequence=11, pids=[1, 2]))
        setattr(observer, 'instrument_substep', lambda name, fn, *a, **k: fn(*a, **k))
        setattr(observer, 'capture_queued_identity', lambda *a, **k: None)
        setattr(observer, 'checkpoint_append_boundaries', lambda *a, **k: None)
        setattr(observer, 'checkpoint_appends', lambda *a, **k: None)
        setattr(observer, 'capture_bti_pending', lambda *a, **k: None)
        setattr(observer, 'capture_clone3_pending', lambda *a, **k: None)
        setattr(observer, 'capture_deferred_mremap', lambda *a, **k: False)
        observer.__class__ = DispatcherObserver
        DispatcherObserver.processed = []
        return observer

    def test_declined_capture_still_drains_remaining_peers_before_resume(self):
        """L's defect: a declined capture `break` left peer captures pending.

        Drives the ACTUAL pending_captures_original and resume_original with
        initialised stopped peers: the first capture declines, the second must
        still be processed before resume runs.
        """
        observer = self._dispatcher_observer()

        processed = DispatcherObserver.processed

        observer.tasks = {
            1: dict(stopped=True, exited=False, tgid=1, fdTable=1,
                    entry=dict(sequence=10, arch=0xc000003e, nr=backend.TIMESTAMP_SYSCALLS[0xc000003e], args=[0] * 6),
                    capture=(None, 'metadata-before')),
            2: dict(stopped=True, exited=False, tgid=2, fdTable=2,
                    entry=dict(sequence=20, arch=0xc000003e, nr=1, args=[0] * 6),
                    capture=(3, 'writer-before')),
        }
        observer.pending_captures_original()
        self.assertIn(('write', 2, 3), processed,
                      'the second pending peer must be captured, not skipped')
        self.assertIsNone(observer.tasks[1].get('capture'))
        self.assertIsNone(observer.tasks[2].get('capture'))
        resumed = []
        real_trace = backend.single.trace
        backend.single.trace = lambda request, pid, *args: resumed.append(pid)
        try:
            observer.resume_original()
        finally:
            backend.single.trace = real_trace
        self.assertEqual(resumed, [2], 'only the captured writer may resume')
        self.assertTrue(observer.tasks[1]['stopped'])

    def test_multiple_declines_still_terminate(self):
        """Two consecutive declines must drain and terminate (no infinite loop)."""
        observer = self._dispatcher_observer()
        observer.tasks = {
            1: dict(stopped=True, exited=False, tgid=1, fdTable=1,
                    entry=dict(sequence=10, arch=0xc000003e, nr=backend.TIMESTAMP_SYSCALLS[0xc000003e], args=[0] * 6),
                    capture=(None, 'metadata-before')),
            2: dict(stopped=True, exited=False, tgid=2, fdTable=2,
                    entry=dict(sequence=20, arch=0xc000003e, nr=backend.TIMESTAMP_SYSCALLS[0xc000003e], args=[0] * 6),
                    capture=(None, 'metadata-before')),
        }
        observer.pending_captures_original()
        self.assertIsNone(observer.tasks[1].get('capture'))
        self.assertIsNone(observer.tasks[2].get('capture'))

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
