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


if __name__ == '__main__':
    unittest.main()
