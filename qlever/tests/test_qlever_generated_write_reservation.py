"""Actual production generated-write reservation regressions.

These use the real Observer.capture_write/complete_write methods, the real
Runtime.write_baseline/complete_write_bridge path, the production chunk store,
and the shared observer byte ledger. Only kernel stop/barrier/emit plumbing is
reduced to a deterministic in-process harness; the file, FD, chunk and budget
accounting are real.
"""
import hashlib
import importlib.util
import io
import os
import tempfile
import time
import unittest
from contextlib import ExitStack, redirect_stderr
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'qlever/scripts'
PID = 10
FD = 10
ENTRY_SEQUENCE = 200
EXIT_SEQUENCE = 300


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


core = load('generated_write_observer', 'sdk-ptrace-execution.py')
vma = load('generated_write_vma', 'sdk-generated-vma-originals.py')


class _RawSink:
    def write(self, _data):
        pass

    def flush(self):
        pass


class Harness:
    """One actual Observer plus one retained generated origin."""

    def __init__(self, root, *, test, capture_content_entities=True, maximum_file_bytes=1024 * 1024):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        self.out = root / 'out'
        self.out.mkdir()
        self.source = root / 'source'
        self.source.mkdir()
        self.build = root / 'build'
        self.build.mkdir()
        self.obs = core.Observer(
            self.out, self.source, self.build,
            generated_build_root=str(self.build.resolve()),
            generated_vma_output=True, generated_vma_shared_mm=True,
            generated_vma_private_wake=True, generated_vma_private_wait_mismatch=True,
            generated_vma_coordinated_wait=True, generated_vma_parked_wait=True,
            shared_tasks=True, capture_toolchain=True,
            capture_content_entities=capture_content_entities,
            retained_generated_metadata=True, indexed_raw_records=False,
            compressed_raw=True, maximum_bytes=1024 ** 3,
            maximum_file_bytes=maximum_file_bytes, maximum_processes=16,
            deadline_monotonic=time.monotonic() + 120, check_budget=lambda: None,
        )
        self.obs.check = lambda: None
        self.obs.check_full = lambda: None
        self.obs.check_deadline = lambda: None
        self.obs.check_emit = lambda: None
        self.obs.raw = _RawSink()
        self.obs.raw_logical_limit = 1024 ** 3
        self.obs.logical_raw_bytes = 0
        self.seq = 100
        self.obs.emit = self._emit
        self.obs.barrier = lambda: dict(
            kind='all-stop-barrier', sequence=1, pids=[PID],
            taskOwnership=[dict(tid=PID, fdTable=PID)],
        )
        self.obs.sole_writer = lambda pid, fd, identity: [dict(pid=pid, fd=fd)]
        self.fd = None
        self.held = None
        test.addCleanup(self._cleanup)

    def _emit(self, row):
        self.seq += 1
        emitted = dict(row, sequence=self.seq)
        self.obs.generated_vma.record(emitted)
        return emitted

    def _cleanup(self):
        self.obs.generated_vma.origins.clear()
        self.obs.generated_vma.reserved = 0
        for fd in (self.held, self.fd):
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass

    def origin(self, data):
        path = self.root / 'generated.bin'
        path.write_bytes(data)
        self.fd = os.open(path, os.O_RDWR)
        self.held = os.dup(self.fd)
        self.path = path
        identity = vma.identity(os.fstat(self.held))
        reference = self.obs.snapshot_write_original(self.held, len(data))
        self.origin_row = dict(
            pid=PID, fd=FD, sequence=self.seq, path=str(path), held=self.held,
            identity=identity, data=(len(data), hashlib.sha256(data).hexdigest()),
            original=reference,
        )
        self.obs.retained.add(self.held)
        self.obs.generated_vma.origins[tuple(identity[:2])] = self.origin_row
        self.obs.generated_vma.lookup_fd = lambda _pid, _fd: self.origin_row
        self.domain_before = self.obs.domain_bytes
        self.disk_before = self.disk_bytes()
        self.obs.tasks = {PID: dict(
            entry=dict(kind='kernel-syscall', op='entry', pid=PID,
                       sequence=ENTRY_SEQUENCE, arch=0xc00000b7, nr=64,
                       args=[FD, 0, 0, 0, 0, 0]),
            exited=False, stopped=True, fdTable=PID,
        )}
        return self.origin_row

    def disk_bytes(self):
        return sum(path.stat().st_size for path in self.out.rglob('*') if path.is_file())

    def _patches(self, offset, *, open_files=True):
        stack = ExitStack()
        if open_files:
            real_open = os.open

            def opened(path, *args, **kwargs):
                name = str(path)
                if name == '/proc/%d/fd/%d' % (PID, FD):
                    return real_open(self.path, *args, **kwargs)
                if name == '/proc/%d/mem' % PID:
                    return real_open(self.buffer_path, *args, **kwargs)
                return real_open(path, *args, **kwargs)

            stack.enter_context(patch.object(core.os, 'open', side_effect=opened))
        real_stat = os.stat

        def statted(path, *args, **kwargs):
            if str(path) == '/proc/%d/fd/%d' % (PID, FD):
                return real_stat(self.path, *args, **kwargs)
            return real_stat(path, *args, **kwargs)

        stack.enter_context(patch.object(core.os, 'stat', side_effect=statted))
        stack.enter_context(patch.object(core, 'fdpath', return_value=str(self.path)))
        stack.enter_context(patch.object(core, 'descriptor_flags', return_value=2))
        stack.enter_context(patch.object(core, 'descriptor_position', return_value=offset))
        return stack

    def write(self, *, offset, count, payload, remaining):
        self.buffer_path = self.root / 'write-buffer.bin'
        with open(self.buffer_path, 'wb') as buffer:
            buffer.truncate(offset + count)
            if count:
                buffer.seek(offset)
                buffer.write(payload)
        self.obs.maximum_bytes = self.domain_before + remaining
        self.obs.tasks[PID]['entry'].update(args=[FD, offset, count, 0, 0, 0])
        with self._patches(offset):
            window = core.Observer.capture_write(self.obs, PID, FD)
        reserved = self.obs.generated_vma.reserved
        os.pwrite(self.fd, payload, offset)
        self.obs.exclusive = (PID, ENTRY_SEQUENCE)
        with self._patches(offset, open_files=False):
            core.Observer.complete_write(
                self.obs, PID, self.obs.tasks[PID]['entry'],
                dict(sequence=EXIT_SEQUENCE, result=count, isError=False),
            )
        transition = self.obs.write_states.get(tuple(self.origin_row['identity'][:2]))
        assert self.obs.domain_bytes + getattr(self.obs, 'chunk_reserved', 0) + self.obs.generated_vma.reserved <= self.obs.maximum_bytes
        return window, transition, reserved


class GeneratedWriteReservationTest(unittest.TestCase):
    def setUp(self):
        parent = ROOT / '.test-data/sdk-generated-write-reservation'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_actual_failure_numbers_remove_exactly_one_preimage(self):
        before, count, offset = 15_888_896, 4_096, 15_889_408
        post = max(before, offset + count)
        new = vma.generated_write_reserve(before, count, offset)
        old = 2 * before + count + post + vma.GENERATED_WRITE_SLACK
        actual_projection = before + count + post
        self.assertEqual(new, actual_projection + vma.GENERATED_WRITE_SLACK)
        self.assertEqual(old, 48_330_752)
        self.assertEqual(new, 32_441_856)
        self.assertLessEqual(new, 42_104_387)
        self.assertGreater(old, 42_104_387)

    def test_actual_chunked_write_admits_at_exact_new_reserve_and_completes(self):
        data = b'A' * (256 * 1024)
        harness = Harness(self.root, test=self, capture_content_entities=True)
        harness.origin(data)
        before, count, offset = len(data), 4_096, 100_000
        new_reserve = vma.generated_write_reserve(before, count, offset)
        old_reserve = 2 * before + count + max(before, offset + count) + vma.GENERATED_WRITE_SLACK
        self.assertGreater(old_reserve, new_reserve)
        window, transition, reserved = harness.write(
            offset=offset, count=count, payload=b'B' * count, remaining=new_reserve,
        )
        manifest_bytes = window['initialBefore']['storage']['manifest']['bytes']
        self.assertEqual(reserved, new_reserve - count - manifest_bytes)
        self.assertEqual(harness.obs.generated_vma.reserved, 0)
        self.assertEqual(getattr(harness.obs, 'chunk_reserved', 0), 0)
        self.assertLessEqual(harness.obs.domain_bytes, harness.obs.maximum_bytes)
        self.assertEqual(window['buffer']['bytes'], count)
        self.assertLessEqual(harness.obs.domain_bytes - harness.domain_before, new_reserve)
        self.assertLessEqual(harness.disk_bytes() - harness.disk_before, new_reserve)
        self.assertEqual(transition['afterIdentity'][3], before)
        self.assertEqual(os.pread(harness.fd, before, 0), data[:offset] + b'B' * count + data[offset + count:])

    def test_actual_raw_fallback_near_limit_consumes_exact_reservation(self):
        data = b'A' * (256 * 1024)
        harness = Harness(self.root, test=self, capture_content_entities=False)
        harness.origin(data)
        before, count, offset = len(data), 4_096, 100_000
        new_reserve = vma.generated_write_reserve(before, count, offset)
        old_reserve = 2 * before + count + max(before, offset + count) + vma.GENERATED_WRITE_SLACK
        self.assertGreater(old_reserve - new_reserve, count)
        window, transition, reserved = harness.write(
            offset=offset, count=count, payload=b'B' * count, remaining=new_reserve,
        )
        self.assertEqual(reserved, new_reserve - before - count)
        self.assertEqual(harness.obs.generated_vma.reserved, 0)
        self.assertEqual(getattr(harness.obs, 'chunk_reserved', 0), 0)
        self.assertLessEqual(harness.obs.domain_bytes, harness.obs.maximum_bytes)
        self.assertGreater(harness.obs.domain_bytes - harness.domain_before, 0)
        self.assertLessEqual(harness.obs.domain_bytes - harness.domain_before, new_reserve)
        self.assertLessEqual(harness.disk_bytes() - harness.disk_before, new_reserve)
        self.assertEqual(os.pread(harness.fd, before, 0), data[:offset] + b'B' * count + data[offset + count:])

    def test_actual_write_refuses_below_actual_physical_need_and_rolls_back(self):
        data = b'A' * (256 * 1024)
        before, count, offset = len(data), 4_096, 100_000
        probe = Harness(self.root / 'probe', test=self, capture_content_entities=True)
        probe.origin(data)
        probe.write(offset=offset, count=count, payload=b'B' * count,
                    remaining=vma.generated_write_reserve(before, count, offset))
        needed = probe.obs.domain_bytes - probe.domain_before
        self.assertGreater(needed, count)

        harness = Harness(self.root / 'short', test=self, capture_content_entities=True)
        harness.origin(data)
        harness.obs.maximum_bytes = harness.domain_before + needed - 1
        harness.buffer_path = self.root / 'write-buffer.bin'
        harness.buffer_path.write_bytes(b'\0' * (offset + count))
        harness.obs.tasks[PID]['entry'].update(args=[FD, offset, count, 0, 0, 0])
        digest_before = hashlib.sha256(data).hexdigest()
        with harness._patches(offset), redirect_stderr(io.StringIO()) as diagnostic:
            with self.assertRaises(AssertionError):
                core.Observer.capture_write(harness.obs, PID, FD)
        self.assertLessEqual(len(diagnostic.getvalue()), 4096)
        self.assertEqual(harness.obs.generated_vma.reserved, 0)
        self.assertEqual(getattr(harness.obs, 'chunk_reserved', 0), 0)
        self.assertFalse(harness.origin_row.get('writePending'))
        self.assertLessEqual(harness.obs.domain_bytes, harness.obs.maximum_bytes)
        self.assertEqual(hashlib.sha256(os.pread(harness.fd, before, 0)).hexdigest(), digest_before)
        self.assertNotIn('writeWindow', harness.obs.tasks[PID])

    def test_actual_write_rejects_stale_and_foreign_origin(self):
        data = b'A' * (256 * 1024)
        harness = Harness(self.root, test=self, capture_content_entities=True)
        harness.origin(data)
        before, count, offset = len(data), 4_096, 100_000
        new_reserve = vma.generated_write_reserve(before, count, offset)
        harness.obs.maximum_bytes = harness.domain_before + new_reserve + 131_072
        harness.buffer_path = self.root / 'write-buffer.bin'
        harness.buffer_path.write_bytes(b'\0' * (offset + count))
        harness.obs.tasks[PID]['entry'].update(args=[FD, offset, count, 0, 0, 0])
        os.pwrite(harness.fd, b'Z', before)
        stale = hashlib.sha256(os.pread(harness.fd, before + 1, 0)).hexdigest()
        with harness._patches(offset):
            with self.assertRaises(ValueError):
                core.Observer.capture_write(harness.obs, PID, FD)
        self.assertEqual(harness.obs.generated_vma.reserved, 0)
        self.assertEqual(hashlib.sha256(os.pread(harness.fd, before + 1, 0)).hexdigest(), stale)
        os.ftruncate(harness.fd, before)
        os.pwrite(harness.fd, data, 0)
        harness.origin_row['fd'] = FD + 1
        with self.assertRaises(ValueError):
            harness.obs.generated_vma.write_baseline(
                PID, FD, harness.origin_row['identity'], before, offset,
            )
        self.assertEqual(harness.obs.generated_vma.reserved, 0)
        harness.origin_row['fd'] = FD

    def test_capture_failure_after_reservation_aborts_credit_and_pending(self):
        data = b'A' * (256 * 1024)
        harness = Harness(self.root, test=self, capture_content_entities=True)
        harness.origin(data)
        before, count, offset = len(data), 4_096, 100_000
        harness.obs.maximum_bytes = harness.domain_before + vma.generated_write_reserve(before, count, offset)
        harness.buffer_path = self.root / 'write-buffer.bin'
        harness.buffer_path.write_bytes(b'\0' * offset + b'B' * count)
        harness.obs.tasks[PID]['entry'].update(args=[FD, offset, count, 0, 0, 0])
        primary = ValueError('injected capture failure')
        harness.obs.snapshot_write_original = lambda *args, **kwargs: (_ for _ in ()).throw(primary)
        with harness._patches(offset), self.assertRaises(ValueError) as caught:
            core.Observer.capture_write(harness.obs, PID, FD)
        self.assertIs(caught.exception, primary)
        self.assertEqual(harness.obs.generated_vma.reserved, 0)
        self.assertEqual(getattr(harness.obs, 'chunk_reserved', 0), 0)
        self.assertFalse(harness.origin_row.get('writePending'))
        self.assertFalse(harness.obs.generated_vma.write_active)
        self.assertEqual(os.pread(harness.fd, before, 0), data)
        self.assertNotIn('writeWindow', harness.obs.tasks[PID])

    def test_complete_failure_releases_reservation_and_pending_without_masking(self):
        data = b'A' * (256 * 1024)
        harness = Harness(self.root, test=self, capture_content_entities=True)
        harness.origin(data)
        before, count, offset = len(data), 4_096, 100_000
        new_reserve = vma.generated_write_reserve(before, count, offset)
        harness.obs.maximum_bytes = harness.domain_before + new_reserve
        harness.buffer_path = self.root / 'write-buffer.bin'
        harness.buffer_path.write_bytes(b'\0' * offset + b'B' * count)
        harness.obs.tasks[PID]['entry'].update(args=[FD, offset, count, 0, 0, 0])
        with harness._patches(offset):
            core.Observer.capture_write(harness.obs, PID, FD)
        os.pwrite(harness.fd, b'B' * count, offset)
        harness.obs.exclusive = (PID, ENTRY_SEQUENCE)
        primary = ValueError('actual postimage bridge failed')
        with harness._patches(offset, open_files=False), patch.object(
            harness.obs.generated_vma, 'snapshot', side_effect=primary,
        ):
            with self.assertRaises(ValueError) as caught:
                core.Observer.complete_write(
                    harness.obs, PID, harness.obs.tasks[PID]['entry'],
                    dict(sequence=EXIT_SEQUENCE, result=count, isError=False),
                )
        self.assertIs(caught.exception, primary)
        self.assertEqual(harness.obs.generated_vma.reserved, 0)
        self.assertEqual(getattr(harness.obs, 'chunk_reserved', 0), 0)
        self.assertFalse(harness.origin_row.get('writePending'))
        self.assertFalse(harness.obs.generated_vma.write_active)
        self.assertLessEqual(harness.obs.domain_bytes, harness.obs.maximum_bytes)
        self.assertEqual(os.pread(harness.fd, before, 0), data[:offset] + b'B' * count + data[offset + count:])

    def test_generated_credit_is_owner_thread_epoch_and_window_only(self):
        import threading
        data = b'A' * (256 * 1024)
        harness = Harness(self.root, test=self, capture_content_entities=True)
        harness.origin(data)
        before, count, offset = len(data), 4_096, 100_000
        harness.obs.tasks[PID]['entry'].update(args=[FD, offset, count, 0, 0, 0])
        origin = harness.obs.generated_vma.write_baseline(
            PID, FD, harness.origin_row['identity'], before, offset,
        )
        generated = harness.obs.generated_vma
        self.assertTrue(generated.write_active)
        self.assertGreater(generated.reserved, 0)
        credit = generated.reserved
        harness.obs.maximum_bytes = harness.obs.domain_bytes + credit
        owner_available = min(harness.obs.maximum_bytes - harness.obs.domain_bytes - harness.obs.chunk_reserved, credit)
        same = core.CaptureReservation(harness.obs, generated_epoch=origin['writeEpoch'])
        self.assertEqual(same.remaining_bytes(), owner_available)
        results = {}

        def foreign_thread():
            other = core.CaptureReservation(harness.obs, generated_epoch=origin['writeEpoch'])
            results['remaining'] = other.remaining_bytes()
            try:
                other.reserve(results['remaining'] + 1)
            except AssertionError:
                results['refused'] = True

        thread = threading.Thread(target=foreign_thread)
        thread.start()
        thread.join()
        self.assertEqual(results['remaining'], 0)
        self.assertTrue(results['refused'])
        stale = core.CaptureReservation(harness.obs, generated_epoch=origin['writeEpoch'] + 1)
        self.assertEqual(stale.remaining_bytes(), 0)
        with self.assertRaises(ValueError):
            generated.write_baseline(PID, FD, harness.origin_row['identity'], before, offset)
        self.assertEqual(generated.reserved, credit)
        generated.abort_write(origin)
        self.assertEqual(generated.reserved, 0)
        self.assertFalse(origin.get('writePending'))
        self.assertFalse(generated.write_active)

    def test_production_entry_emit_then_pending_capture_completes_with_full_postimage(self):
        data = b'A' * (256 * 1024)
        harness = Harness(self.root, test=self, capture_content_entities=True)
        harness.origin(data)
        before, count, offset = len(data), 4_096, 100_000
        new_reserve = vma.generated_write_reserve(before, count, offset)
        harness.obs.maximum_bytes = harness.domain_before + new_reserve
        harness.buffer_path = self.root / 'write-buffer.bin'
        harness.buffer_path.write_bytes(b'\0' * offset + b'B' * count)
        harness.obs.tasks[PID]['entry'].update(args=[FD, offset, count, 0, 0, 0])
        harness.obs.instrument_substep = lambda name, function, *args, **kwargs: function(*args, **kwargs)
        # Use the real Runtime.lookup_fd: the Linux /proc/<pid>/fd/<fd> lookup is
        # supplied by the harness's existing real-stat path mapping.
        del harness.obs.generated_vma.lookup_fd
        with harness._patches(offset):
            entry = harness.obs.emit(dict(
                kind='kernel-syscall', pid=PID, op='entry', arch=0xc00000b7,
                nr=64, isError=False, result=0, args=[FD, offset, count, 0, 0, 0],
            ))
            harness.obs.tasks[PID]['entry'] = entry
            self.assertTrue(harness.origin_row.get('writePending'))
            harness.obs.tasks[PID]['capture'] = (FD, 'writer-before')
            harness.obs.pending_captures_original()
            window = harness.obs.tasks[PID]['writeWindow'][0]
            self.assertTrue(harness.obs.generated_vma.write_active)
            reserved_after_capture = harness.obs.generated_vma.reserved
            manifest_bytes = window['initialBefore']['storage']['manifest']['bytes']
            self.assertEqual(reserved_after_capture, new_reserve - count - manifest_bytes)
            with self.assertRaises(ValueError):
                harness.obs.generated_vma.write_baseline(
                    PID, FD, harness.origin_row['identity'], before, offset,
                )
            self.assertEqual(harness.obs.generated_vma.reserved, reserved_after_capture)
        os.pwrite(harness.fd, b'B' * count, offset)
        harness.obs.exclusive = (PID, entry['sequence'])
        with harness._patches(offset, open_files=False):
            core.Observer.complete_write(
                harness.obs, PID, entry,
                dict(sequence=EXIT_SEQUENCE, result=count, isError=False),
            )
        expected = data[:offset] + b'B' * count + data[offset + count:]
        transition = harness.obs.write_states[tuple(harness.origin_row['identity'][:2])]
        self.assertEqual(transition['afterIdentity'][3], before)
        self.assertEqual(transition['after'], dict(bytes=before, sha256=hashlib.sha256(expected).hexdigest()))
        self.assertEqual(harness.origin_row['data'], (before, hashlib.sha256(expected).hexdigest()))
        self.assertEqual(harness.origin_row['original']['bytes'], before)
        self.assertEqual(harness.origin_row['original']['sha256'], hashlib.sha256(expected).hexdigest())
        self.assertEqual(os.pread(harness.fd, before, 0), expected)
        self.assertFalse(harness.origin_row.get('writePending'))
        self.assertFalse(harness.obs.generated_vma.write_active)
        self.assertEqual(harness.obs.generated_vma.reserved, 0)
        self.assertEqual(getattr(harness.obs, 'chunk_reserved', 0), 0)
        self.assertLessEqual(harness.obs.domain_bytes, harness.obs.maximum_bytes)
        self.assertNotIn('writeWindow', harness.obs.tasks[PID])
        self.assertNotIn('generatedWriteOrigin', harness.obs.tasks[PID])

    def test_actual_append_overwrite_hole_and_zero_paths(self):
        cases = (
            ('overwrite', 100_000, 4_096, b'B' * 4_096),
            ('append', 256 * 1024, 4_096, b'C' * 4_096),
            ('hole', 256 * 1024 + 8_192, 1, b'D'),
            ('zero', 256 * 1024, 0, b''),
        )
        for label, offset, count, payload in cases:
            with self.subTest(label=label):
                harness = Harness(self.root / label, test=self, capture_content_entities=True)
                data = b'A' * (256 * 1024)
                harness.origin(data)
                new_reserve = vma.generated_write_reserve(len(data), count, offset)
                window, transition, reserved = harness.write(
                    offset=offset, count=count, payload=payload,
                    remaining=new_reserve,
                )
                expected = bytearray(data)
                if count:
                    if offset > len(expected):
                        expected.extend(bytes(offset - len(expected)))
                    expected[offset:offset + count] = payload
                manifest_bytes = window['initialBefore']['storage']['manifest']['bytes']
                self.assertEqual(reserved, new_reserve - count - manifest_bytes)
                self.assertEqual(harness.obs.generated_vma.reserved, 0)
                self.assertEqual(getattr(harness.obs, 'chunk_reserved', 0), 0)
                self.assertEqual(os.fstat(harness.fd).st_size, len(expected))
                self.assertEqual(os.pread(harness.fd, len(expected), 0), bytes(expected))
                self.assertLessEqual(harness.obs.domain_bytes - harness.domain_before, new_reserve)

    def test_actual_512mib_sparse_manifest_exceeds_slack_but_projection_covers(self):
        # Logical max image, but sparse: the manifest still has all 8,192 chunk entries.
        size = 512 * 1024 * 1024
        harness = Harness(self.root / 'max-image', test=self, capture_content_entities=True, maximum_file_bytes=size)
        path = self.root / 'sparse.bin'
        with open(path, 'wb') as stream:
            stream.truncate(size)
            stream.seek(size - 1)
            stream.write(b'X')
        harness.fd = os.open(path, os.O_RDWR)
        harness.held = os.dup(harness.fd)
        harness.path = path
        identity = vma.identity(os.fstat(harness.held))
        reference = harness.obs.snapshot_write_original(harness.held, size)
        harness.origin_row = dict(
            pid=PID, fd=FD, sequence=harness.seq, path=str(path), held=harness.held,
            identity=identity, data=(size, reference['sha256']), original=reference,
        )
        harness.obs.retained.add(harness.held)
        harness.obs.generated_vma.origins[tuple(identity[:2])] = harness.origin_row
        harness.obs.generated_vma.lookup_fd = lambda _pid, _fd: harness.origin_row
        harness.domain_before = harness.obs.domain_bytes
        harness.disk_before = harness.disk_bytes()
        manifest_bytes = reference['storage']['manifest']['bytes']
        self.assertEqual((harness.out / reference['storage']['manifest']['path']).stat().st_size, manifest_bytes)
        self.assertGreater(manifest_bytes, vma.GENERATED_WRITE_SLACK)
        reserve = vma.generated_write_reserve(size, 1, size - 1)
        self.assertGreater(reserve, size)
        self.assertGreater(reserve - size, manifest_bytes)
        harness.obs.tasks = {PID: dict(
            entry=dict(kind='kernel-syscall', op='entry', pid=PID,
                       sequence=ENTRY_SEQUENCE, arch=0xc00000b7, nr=64,
                       args=[FD, size - 1, 1, 0, 0, 0]),
            exited=False, stopped=True, fdTable=PID,
        )}
        window, transition, reserved = harness.write(
            offset=size - 1, count=1, payload=b'Y', remaining=reserve,
        )
        self.assertGreater(reserved, 0)
        self.assertEqual(transition['afterIdentity'][3], size)
        self.assertEqual(os.pread(harness.fd, 1, size - 1), b'Y')
        self.assertEqual(harness.obs.generated_vma.reserved, 0)
        self.assertEqual(getattr(harness.obs, 'chunk_reserved', 0), 0)
        self.assertLessEqual(harness.obs.domain_bytes, harness.obs.maximum_bytes)
        self.assertLessEqual(harness.disk_bytes() - harness.disk_before, reserve)


if __name__ == '__main__':
    unittest.main()
