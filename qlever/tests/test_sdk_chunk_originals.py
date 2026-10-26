"""Focused real-FD regressions for the production chunk-original SDK store.

Everything loaded here comes from the production scripts under ROOT/qlever/scripts.
Temporary trees live under ROOT/.test-data/sdk-chunk-originals and are removed by
TemporaryDirectory; no native ptrace claim is made by this file.
"""
import hashlib
import importlib.util
import io
import json
import os
import tempfile
import time
import unittest
import zipfile
from pathlib import Path

ROOT = Path(os.environ.get('XPOD_TEST_REPO_ROOT') or Path(__file__).resolve().parents[2])
SCRIPTS = ROOT / 'qlever/scripts'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


store = load('candidate_chunk_store', 'sdk-original-chunk-store.py')
core = load('candidate_ptrace_execution', 'sdk-ptrace-execution.py')
bindings = load('candidate_multiprocess_bindings', 'sdk-generation-multiprocess-bindings.py')
scanner = load('candidate_generated_source_originals', 'sdk-generated-source-originals.py')

_fresh = [0]


def fresh_store(tag):
    """Reload the production store so no writer/reader module state is shared."""
    _fresh[0] += 1
    return load('fresh_store_%s_%d' % (tag, _fresh[0]), 'sdk-original-chunk-store.py')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def ref(path, data):
    return dict(path=path, bytes=len(data), sha256=sha(data))


def write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError('short write')
        view = view[written:]


def disk_sum(root):
    total = 0
    for sub in ('chunks', 'manifests'):
        directory = root / sub
        if not directory.is_dir():
            continue
        for entry in os.scandir(directory):
            total += entry.stat(follow_symlinks=False).st_size
    return total


def txn_names(root):
    if not root.is_dir():
        return set()
    return {entry.name for entry in os.scandir(root) if entry.name.startswith('.txn-')}


class TemporaryTreeTests(unittest.TestCase):
    def setUp(self):
        parent = ROOT / '.test-data/sdk-chunk-originals'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)


class ChunkStoreTests(TemporaryTreeTests):

    def test_real_fd_two_appends_share_a_chunk_and_ledger_matches_disk(self):
        root = self.root / 'root'
        root.mkdir()
        source = self.root / 'source.bin'
        fd = os.open(source, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
        self.addCleanup(os.close, fd)
        ledger = store.Ledger(10_000_000)
        shared = sha(b'A' * store.CHUNK_SIZE)
        payload = b'A' * store.CHUNK_SIZE + b'B' * (store.CHUNK_SIZE // 2) + b'C' * 1000
        write_all(fd, payload)
        os.fsync(fd)
        expected = payload
        manifests = []

        def snapshot(sequence):
            result = store.snapshot(root, fd, sequence, ledger)
            self.assertEqual(result['path'], 'manifests/%d.json' % sequence)
            manifests.append(result)
            # A reader loaded from scratch sees only the published files.
            self.assertEqual(b''.join(fresh_store('append%d' % sequence).blocks(root, result)), expected)
            self.assertEqual(ledger.reserved_bytes, 0)
            self.assertEqual(ledger.retained_bytes, disk_sum(root))
            self.assertEqual((root / result['path']).stat().st_size, result['bytes'])
            return result

        snapshot(0)
        shared_chunk = root / 'chunks' / shared
        self.assertTrue(shared_chunk.is_file())
        shared_inode = shared_chunk.stat().st_ino

        write_all(fd, b'D' * 3000)
        os.fsync(fd)
        expected += b'D' * 3000
        snapshot(1)
        write_all(fd, b'E' * store.CHUNK_SIZE + b'F' * 17)
        os.fsync(fd)
        expected += b'E' * store.CHUNK_SIZE + b'F' * 17
        snapshot(2)

        # The first 64 KiB chunk is physically shared by every later append.
        self.assertEqual(shared_chunk.stat().st_ino, shared_inode)
        expected_chunks = set()
        for result in manifests:
            manifest = json.loads((root / result['path']).read_bytes())
            self.assertIn(shared, [chunk['sha256'] for chunk in manifest['chunks']])
            expected_chunks.update(chunk['sha256'] for chunk in manifest['chunks'])
        self.assertEqual({entry.name for entry in (root / 'chunks').iterdir()}, expected_chunks)
        self.assertEqual(ledger.retained_bytes, disk_sum(root))
        self.assertGreater(ledger.retained_bytes, len(expected))

    def test_one_byte_short_and_exact_full_budget_reject_without_drift(self):
        root = self.root / 'root'
        root.mkdir()
        payload = b'B' * 7000
        source = self.root / 'source.bin'
        source.write_bytes(payload)
        fd = os.open(source, os.O_RDONLY)
        self.addCleanup(os.close, fd)
        chunks = (len(payload) + store.CHUNK_SIZE - 1) // store.CHUNK_SIZE
        needed = len(payload) + store.MANIFEST_BASE_BOUND + chunks * store.MANIFEST_CHUNK_BOUND

        short = store.Ledger(needed - 1)
        with self.assertRaises(store.LedgerValidationError):
            store.snapshot(root, fd, 0, short)
        self.assertEqual(short.retained_bytes, 0)
        self.assertEqual(short.reserved_bytes, 0)
        self.assertEqual(disk_sum(root), 0)
        self.assertEqual(txn_names(root), set())

        exact = store.Ledger(needed)
        result = store.snapshot(root, fd, 0, exact)
        self.assertEqual(b''.join(fresh_store('budget_exact').blocks(root, result)), payload)
        retained = exact.retained_bytes
        self.assertEqual(retained, disk_sum(root))

        full = store.Ledger(retained, retained_bytes=retained)
        before = disk_sum(root)
        with self.assertRaises(store.LedgerValidationError):
            store.snapshot(root, fd, 1, full)
        self.assertEqual(full.retained_bytes, retained)
        self.assertEqual(full.reserved_bytes, 0)
        self.assertEqual(disk_sum(root), before)
        self.assertFalse((root / 'manifests/1.json').exists())
        self.assertEqual(txn_names(root), set())

    def test_real_disk_chunk_tamper_is_rejected_then_restores(self):
        root = self.root / 'root'
        root.mkdir()
        payload = b'T' * store.CHUNK_SIZE + b'U' * 2000
        source = self.root / 'source.bin'
        source.write_bytes(payload)
        fd = os.open(source, os.O_RDONLY)
        self.addCleanup(os.close, fd)
        result = store.snapshot(root, fd, 0, store.Ledger(10_000_000))
        manifest = json.loads((root / result['path']).read_bytes())
        self.assertEqual(len(manifest['chunks']), 2)
        chunk = root / 'chunks' / manifest['chunks'][0]['sha256']
        original = chunk.read_bytes()
        self.assertEqual(b''.join(fresh_store('tamper_clean').blocks(root, result)), payload)

        chunk.write_bytes(bytes([original[0] ^ 0xFF]) + original[1:])
        reader = fresh_store('tamper_bad')
        with self.assertRaises(reader.ManifestError):
            b''.join(reader.blocks(root, result))

        chunk.write_bytes(original)
        self.assertEqual(b''.join(fresh_store('tamper_restore').blocks(root, result)), payload)

    def test_cancellation_at_every_actual_checkpoint_propagates_original(self):
        root = self.root / 'root'
        root.mkdir()
        payload = b'A' * store.CHUNK_SIZE + b'B' * 2000
        source = self.root / 'source.bin'
        source.write_bytes(payload)
        fd = os.open(source, os.O_RDONLY)
        self.addCleanup(os.close, fd)
        result = store.snapshot(root, fd, 0, store.Ledger(10_000_000))
        reader = fresh_store('cancel')
        calls = [0]

        def count_check():
            calls[0] += 1

        parts = list(reader.blocks(root, result, count_check))
        self.assertEqual(b''.join(parts), payload)
        total = calls[0]
        self.assertGreaterEqual(total, 2)

        class CustomCancelled(Exception):
            pass

        for stop in range(1, total + 1):
            seen = [0]
            yielded = []
            failure = CustomCancelled('cancel-%d' % stop)

            def check():
                seen[0] += 1
                if seen[0] == stop:
                    raise failure

            with self.assertRaises(CustomCancelled) as caught:
                for block in reader.blocks(root, result, check):
                    yielded.append(block)
            self.assertIs(caught.exception, failure)
            self.assertEqual(seen[0], stop)
            self.assertEqual(yielded, parts[:len(yielded)])


class BatchedStagingTests(TemporaryTreeTests):
    """Durability/custody contract of batched chunk staging (behavioural only)."""

    def _source(self, chunks):
        payload = b''.join(hashlib.sha256(b'batched-chunk-%d' % i).digest() * 2048
                           for i in range(chunks))[:chunks * store.CHUNK_SIZE]
        source = self.root / ('source-%d.bin' % chunks)
        source.write_bytes(payload)
        return source, payload

    def _snap(self, root, source, sequence, check=None):
        fd = os.open(source, os.O_RDONLY)
        try:
            return store.snapshot(root, fd, sequence, store.Ledger(10_000_000),
                                  check or (lambda: None))
        finally:
            os.close(fd)

    def _clean(self, root, label):
        self.assertFalse((root / 'manifests').is_dir() and any((root / 'manifests').iterdir()),
                         '%s published a manifest' % label)
        chunks = sorted((root / 'chunks').iterdir()) if (root / 'chunks').is_dir() else []
        self.assertEqual(chunks, [], '%s left published chunks' % label)
        self.assertEqual(txn_names(root), set(), '%s left a staging directory' % label)

    def _traced(self, mutate=None):
        """Tracing context: real os.open/fsync/link; ``mutate(name, n, dir_fd)``
        runs just before the n-th staging fsync."""
        state = {'names': {}, 'synced': set(), 'links': [], 'mutated': 0}
        real_open, real_fsync, real_link = store.os.open, store.os.fsync, store.os.link

        def tracked_open(path, flags, *args, **kwargs):
            fd = real_open(path, flags, *args, **kwargs)
            if isinstance(path, str) and path.startswith('chunk-'):
                state['names'][fd] = (path, kwargs.get('dir_fd'))
            else:
                state['names'].pop(fd, None)
            return fd

        def tracked_fsync(fd):
            entry = state['names'].get(fd)
            if entry is not None:
                if mutate is not None:
                    state['mutated'] += 1
                    mutate(entry[0], state['mutated'], entry[1])
            result = real_fsync(fd)
            if entry is not None:
                state['synced'].add(entry[0])
            return result

        def tracked_link(src_name, dst_name, *args, **kwargs):
            if isinstance(src_name, str) and src_name.startswith('chunk-'):
                state['links'].append((src_name, src_name in state['synced']))
            return real_link(src_name, dst_name, *args, **kwargs)

        store.os.open, store.os.fsync, store.os.link = tracked_open, tracked_fsync, tracked_link
        return state, (lambda: setattr(store.os, 'open', real_open) or
                       setattr(store.os, 'fsync', real_fsync) or
                       setattr(store.os, 'link', real_link))

    def test_check_callback_count_is_bounded_constant(self):
        root = self.root / 'root'; root.mkdir()
        source, payload = self._source(128)
        calls = [0]

        def count():
            calls[0] += 1

        result = self._snap(root, source, 0, count)
        manifest = store.read_manifest(root, result)
        self.assertEqual(len(manifest['chunks']), 128)
        self.assertEqual(len({c['sha256'] for c in manifest['chunks']}), 128)
        self.assertEqual(manifest['sha256'], hashlib.sha256(payload).hexdigest())
        self.assertEqual(b''.join(store.blocks(root, result)), payload)
        # Batching must not turn transaction checkpoints into per-chunk scans.
        self.assertEqual(calls[0], 5)
        calls[0] = 0
        self._snap(root, source, 1, count)
        self.assertEqual(calls[0], 5)

    def test_expected_fsync_counts(self):
        root = self.root / 'root'; root.mkdir()
        source, _ = self._source(16)
        real_fsync = store.os.fsync
        seen = []
        store.os.fsync = lambda fd: (seen.append(1), real_fsync(fd))[1]
        try:
            self._snap(root, source, 0); fresh = len(seen); del seen[:]
            self._snap(root, source, 1); existing = len(seen)
        finally:
            store.os.fsync = real_fsync
        self.assertEqual(fresh, 16 + 3)     # per new chunk + manifest + two dirs
        self.assertEqual(existing, 3)       # no new chunk durability

    def test_no_link_before_its_own_fsync(self):
        root = self.root / 'root'; root.mkdir()
        source, _ = self._source(8)
        state, restore = self._traced()
        try:
            self._snap(root, source, 0)
        finally:
            restore()
        self.assertTrue(state['links'])
        self.assertEqual([n for n, synced_at_link in state['links'] if not synced_at_link], [])
        self.assertEqual(len(state['synced']), 8)

    def _fault(self, label, mutate, expect=store.SnapshotError):
        root = self.root / ('root-' + label); root.mkdir()
        source, _ = self._source(8)
        state, restore = self._traced(mutate)
        try:
            with self.assertRaises(expect):
                self._snap(root, source, 0)
        finally:
            restore()
        self.assertGreaterEqual(state['mutated'], 2, '%s mutation never ran' % label)
        self._clean(root, label)
        return state

    def test_same_inode_overwrite_before_flush_is_refused(self):
        def overwrite(name, count, dir_fd):
            if count != 3:
                return
            fd = os.open(name, os.O_WRONLY, dir_fd=dir_fd)
            try:
                os.write(fd, b'Z' * 4096)
            finally:
                os.close(fd)
        self._fault('overwrite', overwrite, store.SnapshotError)

    def test_replacement_symlink_and_size_change_are_refused(self):
        def replace(name, count, dir_fd):
            if count != 2:
                return
            os.unlink(name, dir_fd=dir_fd)
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=dir_fd)
            os.write(fd, b'R' * store.CHUNK_SIZE); os.close(fd)

        def symlink(name, count, dir_fd):
            if count != 2:
                return
            os.unlink(name, dir_fd=dir_fd)
            os.symlink('/etc/passwd', name, dir_fd=dir_fd)

        def truncate(name, count, dir_fd):
            if count != 2:
                return
            fd = os.open(name, os.O_WRONLY, dir_fd=dir_fd)
            try:
                os.ftruncate(fd, 7)
            finally:
                os.close(fd)

        for label, mutate in (('replace', replace), ('symlink', symlink), ('size', truncate)):
            with self.subTest(label=label):
                self._fault(label, mutate)

    def test_fsync_or_link_failure_rolls_back(self):
        for failing in ('fsync', 'link'):
            with self.subTest(failing=failing):
                root = self.root / ('root-' + failing); root.mkdir()
                source, _ = self._source(8)
                original = getattr(store.os, failing)
                calls = [0]
                failure = OSError(5, 'injected %s failure' % failing)

                def broken(*args, **kwargs):
                    calls[0] += 1
                    if calls[0] == 4:
                        raise failure
                    return original(*args, **kwargs)

                setattr(store.os, failing, broken)
                ledger = store.Ledger(10_000_000)
                try:
                    fd = os.open(source, os.O_RDONLY)
                    try:
                        with self.assertRaises(OSError) as caught:
                            store.snapshot(root, fd, 0, ledger)
                        self.assertIs(caught.exception, failure)
                    finally:
                        os.close(fd)
                finally:
                    setattr(store.os, failing, original)
                self._clean(root, failing)
                self.assertEqual(ledger.retained_bytes, 0)
                self.assertEqual(ledger.reserved_bytes, 0)

    def test_interrupt_during_flush_propagates_and_rolls_back(self):
        """Both a real SIGALRM and the outer check callback must abort the batch."""
        import signal

        class ObservationDeadline(TimeoutError):
            pass

        def alarm(signum, frame):
            raise ObservationDeadline('actual owned child observation deadline')

        def fire(name, count, dir_fd):
            if count == 2:
                signal.raise_signal(signal.SIGALRM)

        root = self.root / 'root'; root.mkdir()
        source, _ = self._source(8)
        previous = signal.signal(signal.SIGALRM, alarm)
        state, restore = self._traced(fire)
        try:
            with self.assertRaises(ObservationDeadline):
                self._snap(root, source, 0)
        finally:
            signal.signal(signal.SIGALRM, previous)
            restore()
        self.assertGreaterEqual(state['mutated'], 2)
        self._clean(root, 'sigalrm')

        root = self.root / 'root-callback'; root.mkdir()
        calls = [0]

        def check():
            calls[0] += 1
            if calls[0] == 3:
                raise TimeoutError('actual owned child observation deadline')

        fd = os.open(source, os.O_RDONLY)
        ledger = store.Ledger(10_000_000)
        try:
            with self.assertRaises(TimeoutError):
                store.snapshot(root, fd, 0, ledger, check)
        finally:
            os.close(fd)
        self._clean(root, 'callback')


class RawReferenceTests(TemporaryTreeTests):

    def test_raw_maps_observations_share_physical_and_changed_hash_rejects(self):
        data = b'reused physical maps bytes\n'
        physical = ref('capture-0000.original', data)

        def reader():
            return bindings.CaptureOriginalReader(lambda name, maximum: data, 1000, 1000, lambda: None)

        shared = reader()
        for sequence in (4, 19):
            self.assertEqual(b''.join(shared.blocks(dict(physical, observationSequence=sequence))), data)
        self.assertEqual(shared.physical_bytes, len(data))
        self.assertEqual(list(shared.physical), [physical['path']])

        changed = dict(physical, sha256='0' * 64, observationSequence=20)
        with self.assertRaisesRegex(ValueError, 'logical original reference changed'):
            b''.join(shared.blocks(changed))
        with self.assertRaisesRegex(ValueError, 'physical capture bytes/hash differ'):
            b''.join(reader().blocks(changed))

    def test_legacy_full_offset_and_partial_real_fd_stay_raw(self):
        cases = [('legacy-full', False, 0, 70000), ('offset-range', True, 123, 32000),
                 ('zero-offset-partial', True, 0, 12345)]
        for label, enabled, offset, size in cases:
            with self.subTest(case=label):
                root = self.root / label
                root.mkdir()
                capture = root / 'capture'
                capture.mkdir()
                data = b'0123456789' * 7000
                source = root / 'source'
                source.write_bytes(data)
                observer = core.Observer(
                    capture, '/source', '/build', capture_content_entities=enabled,
                    maximum_bytes=1_000_000, maximum_file_bytes=100_000)
                observer.raw = io.BytesIO()
                observer.current_phase = 'configure'
                observer.deadline = time.monotonic() + 30
                self.addCleanup(observer.close)
                with source.open('rb') as stream:
                    original = observer.snapshot_write_original(stream.fileno(), size, offset=offset)
                expected = data[offset:offset + size]
                self.assertNotIn('storage', original)
                self.assertEqual(b''.join(observer.original_blocks(original)), expected)
                self.assertEqual(original['sha256'], sha(expected))
                rows = [json.loads(line) for line in observer.raw.getvalue().splitlines()]
                self.assertEqual('originalEntityIdentity' in rows[0], enabled)
                self.assertEqual(len(observer.phase_capture_files(0)), 1)
                self.assertEqual(observer.capture_bytes, size)
                self.assertEqual(observer.domain_bytes, size + len(observer.raw.getvalue()))
                reader = bindings.CaptureOriginalReader(
                    lambda name, maximum: (capture / name).read_bytes(), 100_000, 1_000_000, lambda: None)
                self.assertEqual(b''.join(reader.blocks(original)), expected)
                self.assertEqual(reader.physical_bytes, size)


class ArchiveChainTests(TemporaryTreeTests):

    def archive(self, payload):
        path = self.root / 'fixture.zip'
        with zipfile.ZipFile(path, 'w') as output:
            for name, data in payload.items():
                output.writestr(name, data)
        return path

    def test_real_observer_registered_zip_and_offline_observe_rejections(self):
        root = self.root / 'chain'
        root.mkdir()
        captures = root / 'captures'
        captures.mkdir()
        observer = core.Observer(
            captures, '/source', '/build', capture_content_entities=True,
            maximum_bytes=16 * 1024 * 1024, maximum_file_bytes=1024 * 1024)
        self.addCleanup(observer.close)
        observer.current_phase = 'configure'
        observer.raw = io.BytesIO()
        observer.deadline = time.monotonic() + 60
        observer.emit(dict(
            kind='owned-root-binding', pid=123, command=['fixture'],
            backend='ptrace-all-stop-process-v1',
            captureOriginalEntityModel='same-phase-content-entity-v2',
            chunkOriginalStorageModel='chunk-original-v1'))
        source = root / 'source'
        source.write_bytes(b'a' * 65536 + b'b' * 4096)
        with source.open('r+b') as stream:
            observer.snapshot_write_original(stream.fileno(), source.stat().st_size)
            stream.seek(0, 2)
            stream.write(b'c' * 4096)
            stream.flush()
            observer.snapshot_write_original(stream.fileno(), source.stat().st_size)
            observer.snapshot_write_original(stream.fileno(), source.stat().st_size)
        observer.emit(dict(kind='actual-wait-exit', pid=123, returnCode=0))

        prefix = 'inner/toolchain-execution/'
        payload = {}
        for item in observer.phase_capture_files(0):
            name = prefix + 'captures/' + str(Path(item['path']).relative_to(captures))
            payload[name] = Path(item['path']).read_bytes()
        inventory = [ref(name, data) for name, data in payload.items()]
        self.assertEqual(sum(row['bytes'] for row in inventory), observer.capture_bytes)
        self.assertEqual(observer.capture_bytes, observer.claim_bytes['capture-body'])
        self.assertEqual(observer.domain_bytes, observer.capture_bytes + len(observer.raw.getvalue()))
        self.assertEqual(observer.chunk_reserved, 0)

        def add(name, data):
            payload[name] = data
            return ref(name, data)

        index = add(prefix + 'index.json', json.dumps(dict(schemaVersion=1, files=inventory)).encode())
        raw = add(prefix + 'configure.raw', observer.raw.getvalue())
        provider = add(prefix + 'source-provider.mountinfo.raw', b'1 0 0:1 / /source ro - tmpfs tmpfs ro\n')
        plan = dict(
            remainingMilliseconds=30000,
            sourceProviderOriginals=dict(mountinfo=provider),
            sourceRoot='/source', sourceFiles={}, requiredInputs={},
            phases=[dict(
                name='configure', actualCommand=['fixture'], rawTraceShards=[raw],
                captures=dict(indexes=[index], files=len(inventory),
                              bytes=sum(row['bytes'] for row in inventory)))])
        result = scanner.observe(self.archive(payload), plan)
        self.assertEqual(result['phaseTracking'][0]['phase'], 'configure')
        self.assertEqual(result['phaseTracking'][0]['actualRootReturnCode'], 0)

        def extra():
            payload[prefix + 'captures/chunks/' + 'f' * 64] = b'x'

        def missing():
            payload.pop(inventory[0]['path'])

        def tamper():
            payload[inventory[0]['path']] = b'x' * inventory[0]['bytes']

        for label, reason, mutate in [
                ('extra', 'capture original ZIP closed set differs', extra),
                ('missing', 'capture original ZIP closed set differs', missing),
                ('tamper', 'whole original bytes differ', tamper)]:
            saved = dict(payload)
            mutate()
            with self.subTest(mode=label), self.assertRaisesRegex(ValueError, reason):
                scanner.observe(self.archive(payload), plan)
            payload.clear()
            payload.update(saved)
        self.assertEqual(scanner.observe(self.archive(payload), plan)['phaseTracking'][0]['phase'], 'configure')


class SnapshotTelemetryTest(unittest.TestCase):
    """Out-of-band scalar counters must survive a real timeout DURING fsync.

    The production deadline is a SIGALRM inside os.fsync. These tests inject the
    same TimeoutError object at the same call site instead of arming a timer, then
    assert (a) identity of the propagated exception, (b) the counters are exactly
    those at the failure point, and (c) rollback/published state did not change.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='telemetry-', dir=ROOT / '.test-data')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.data = self.root / 'root'
        self.data.mkdir()

    def _source(self, chunks):
        source = self.root / ('source-%d.bin' % chunks)
        fd = os.open(source, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
        self.addCleanup(os.close, fd)
        payload = b''.join(bytes([65 + i]) * store.CHUNK_SIZE for i in range(chunks))
        write_all(fd, payload)
        os.fsync(fd)
        return fd, payload

    def _published(self):
        chunks = sorted(p.name for p in (self.data / 'chunks').iterdir()) if (self.data / 'chunks').is_dir() else []
        manifests = sorted(p.name for p in (self.data / 'manifests').iterdir()) if (self.data / 'manifests').is_dir() else []
        txns = sorted(p.name for p in self.data.iterdir() if p.name.startswith('.txn-'))
        return dict(chunks=chunks, manifests=manifests, txns=txns)

    def test_fresh_and_existing_counts_are_unchanged_and_reported(self):
        fd, _ = self._source(16)
        telemetry = {}
        store.snapshot(self.data, fd, 0, store.Ledger(10_000_000), telemetry=telemetry)
        self.assertEqual(telemetry['stage'], 'done')
        self.assertFalse(telemetry['failed'])
        self.assertEqual(telemetry['chunks'], 16)
        self.assertEqual(telemetry['newChunks'], 16)
        self.assertEqual(telemetry['reusedChunks'], 0)
        self.assertEqual(telemetry['newChunkBytes'], 16 * store.CHUNK_SIZE)
        self.assertEqual(telemetry['stageFsyncStarted'], 16 + 1)   # 16 chunks + manifest
        self.assertEqual(telemetry['stageFsyncCompleted'], 16 + 1)
        self.assertEqual(telemetry['dirFsyncStarted'], 2)          # chunks/ + manifests/
        self.assertEqual(telemetry['dirFsyncCompleted'], 2)
        self.assertGreater(telemetry['manifestBytes'], 0)

        # The pre-existing durability counts must be byte-for-byte unchanged.
        real_fsync = store.os.fsync
        seen = []
        store.os.fsync = lambda target: (seen.append(1), real_fsync(target))[1]
        try:
            store.snapshot(self.data, fd, 1, store.Ledger(10_000_000), telemetry=telemetry)
        finally:
            store.os.fsync = real_fsync
        self.assertEqual(len(seen), 3, 'existing snapshot durability unchanged: manifest + 2 dirs')
        self.assertEqual(telemetry['stageFsyncStarted'], 1)
        self.assertEqual(telemetry['stageFsyncCompleted'], 1)
        self.assertEqual(telemetry['newChunks'], 0)
        self.assertEqual(telemetry['reusedChunks'], 16)

    def test_manifest_fsync_timeout_keeps_exact_counters_and_propagates_same_object(self):
        fd, _ = self._source(8)
        sentinel = TimeoutError('actual owned child observation deadline')
        real_fsync = store.os.fsync
        telemetry = {}
        state = {'manifest_stage': False}

        def tripwire(target):
            # inside the private staging dir: this is the manifest staging inode
            if state['manifest_stage']:
                raise sentinel
            return real_fsync(target)

        real_stage_file = store._stage_file

        def stage_file(txn_fd, name, data, telemetry=None):
            state['manifest_stage'] = True
            try:
                return real_stage_file(txn_fd, name, data, telemetry)
            finally:
                state['manifest_stage'] = False

        store.os.fsync = tripwire
        store._stage_file = stage_file
        try:
            with self.assertRaises(TimeoutError) as caught:
                store.snapshot(self.data, fd, 0, store.Ledger(10_000_000), telemetry=telemetry)
        finally:
            store.os.fsync = real_fsync
            store._stage_file = real_stage_file

        self.assertIs(caught.exception, sentinel, 'the same TimeoutError object must propagate')
        self.assertTrue(telemetry['failed'])
        self.assertEqual(telemetry['errorKind'], 'TimeoutError')
        self.assertEqual(telemetry['stage'], 'stage-manifest')
        # exact counters AT the failed manifest fsync
        self.assertEqual(telemetry['sourceBytes'], 8 * store.CHUNK_SIZE)
        self.assertEqual(telemetry['chunks'], 8)
        self.assertEqual(telemetry['newChunks'], 8)
        self.assertEqual(telemetry['stageFsyncStarted'], 8 + 1)  # 8 chunk flushes + 1 manifest start
        self.assertEqual(telemetry['stageFsyncCompleted'], 8)    # the manifest one did NOT complete
        self.assertEqual(telemetry['dirFsyncStarted'], 1)         # only chunks/ has been synced so far
        self.assertEqual(telemetry['dirFsyncCompleted'], 1)
        self.assertGreater(telemetry['manifestBytes'], 0)
        # no published partial state, and no staging directory left behind
        self.assertEqual(self._published(), dict(chunks=[], manifests=[], txns=[]))

    def test_chunk_fsync_timeout_is_also_reported(self):
        fd, _ = self._source(4)
        sentinel = TimeoutError('actual owned child observation deadline')
        real_fsync = store.os.fsync
        telemetry = {}
        calls = [0]

        def tripwire(target):
            calls[0] += 1
            if calls[0] == 3:      # a per-chunk staging flush, not the manifest
                raise sentinel
            return real_fsync(target)

        store.os.fsync = tripwire
        try:
            with self.assertRaises(TimeoutError) as caught:
                store.snapshot(self.data, fd, 0, store.Ledger(10_000_000), telemetry=telemetry)
        finally:
            store.os.fsync = real_fsync
        self.assertIs(caught.exception, sentinel)
        self.assertEqual(telemetry['stage'], 'flush')
        self.assertEqual(telemetry['stageFsyncStarted'], 3)
        self.assertEqual(telemetry['stageFsyncCompleted'], 2)
        self.assertEqual(telemetry['errorKind'], 'TimeoutError')
        self.assertEqual(self._published(), dict(chunks=[], manifests=[], txns=[]))

    def test_bounded_projection_drops_content_and_foreign_keys(self):
        telemetry = {
            'stage': 'stage-manifest', 'sourceBytes': 7, 'chunks': 1,
            'failed': True, 'errorKind': 'TimeoutError',
            'path': '/etc/passwd', 'sha256': 'a' * 64, 'data': b'secret',
            'query': 'SELECT *', 'token': 'credential',
            'chunksList': [{'sha256': 'b' * 64}],
        }
        row = store.bounded_snapshot_telemetry(telemetry)
        self.assertEqual(set(row) - {'model'}, {
            'stage', 'sourceBytes', 'chunks', 'failed', 'errorKind'})
        for banned in ('path', 'sha256', 'data', 'query', 'token', 'chunksList'):
            self.assertNotIn(banned, row)
        self.assertNotIn('/etc/passwd', json.dumps(row))
        self.assertIsNone(store.bounded_snapshot_telemetry(None))
        self.assertIsNone(store.bounded_snapshot_telemetry(['not', 'a', 'dict']))

    def test_telemetry_absent_path_matches_old_signature(self):
        fd, payload = self._source(2)
        result = store.snapshot(self.data, fd, 0, store.Ledger(10_000_000))
        self.assertEqual(set(result), {'path', 'bytes', 'sha256'})
        self.assertEqual(b''.join(store.blocks(self.data, result)), payload)


if __name__ == '__main__':
    unittest.main()
