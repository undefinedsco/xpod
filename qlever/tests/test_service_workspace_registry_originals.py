"""Actual-module tests for registry transport original retention.

The script is imported as a real module. Its only network boundary,
``urllib.request.build_opener``, is replaced by a fake opener that serves fixed
bytes. No DNS, socket, download or filesystem-external mutation occurs.
"""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/service-workspace-registry-originals.py'
spec = importlib.util.spec_from_file_location('service_workspace_registry_originals_test', SCRIPT)
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)

NAME = 'negotiate'
VERSION = '1.0.1'
ARCHIVE_URL = 'https://registry.npmjs.org/negotiate/-/negotiate-1.0.1.tgz'
METADATA_URL = 'https://registry.npmjs.org/negotiate/1.0.1'
ARCHIVE = b'fixed actual archive bytes\n'


class FakeResponse:
    """Context-managed response with the read/status/headers surface used."""

    def __init__(self, status, body, headers=None):
        self.status = status
        self.body = body
        self.headers = dict(headers or {})
        self.offset = 0

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self, limit=-1):
        if limit is None or limit < 0:
            block = self.body[self.offset:]
        else:
            block = self.body[self.offset:self.offset + limit]
        self.offset += len(block)
        return block


class FakeOpener:
    """Serves queued responses and records every request."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def open(self, request, timeout=None):
        self.requests.append({
            'url': request.full_url,
            'headers': dict(request.header_items()),
            'timeout': timeout,
        })
        if not self.responses:
            raise AssertionError('unexpected transport request: ' + request.full_url)
        return self.responses.pop(0)


class Ledger:
    """Real reserve/settle callbacks recording calls and checking files."""

    def __init__(self, testcase, root):
        self.testcase = testcase
        self.root = root
        self.reserved = []
        self.settled = []

    def reserve(self, amount):
        self.reserved.append(amount)
        return 'token-%d' % len(self.reserved)

    def settle(self, token, refs, maximum_by_path=None):
        self.settled.append((token, list(refs)))
        for ref in refs:
            path = self.root / ref['path']
            self.testcase.assertTrue(path.is_file(), ref['path'])
            actual = path.read_bytes()
            self.testcase.assertEqual(len(actual), ref['bytes'], ref['path'])
            self.testcase.assertEqual(hashlib.sha256(actual).hexdigest(), ref['sha256'], ref['path'])


class WorkspaceRegistryOriginalTests(unittest.TestCase):
    def setUp(self):
        (ROOT / '.test-data').mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / '.test-data')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.assertTrue(self.root.is_absolute())
        self.assertTrue(self.root.is_dir())
        self.lock_integrity = 'sha512-' + base64.b64encode(hashlib.sha512(ARCHIVE).digest()).decode()
        self.metadata = {
            'name': NAME,
            'version': VERSION,
            'dist': {'integrity': self.lock_integrity, 'tarball': ARCHIVE_URL},
        }
        self.source_sha = '0123456789abcdef0123456789abcdef01234567'

    def metadata_body(self):
        return json.dumps(self.metadata, separators=(',', ':')).encode()

    def retained_directory(self):
        return (self.root / 'build-inputs/registry' /
                base64.b64decode(self.lock_integrity[7:]).hex())

    def responses(self, archive=ARCHIVE, metadata=None, probe_status=206):
        body = self.metadata_body() if metadata is None else metadata
        probe_headers = {'Content-Range': 'bytes 0-0/%d' % len(archive)}
        return [
            FakeResponse(200, body, {'Content-Type': 'application/json'}),
            FakeResponse(probe_status, b'x', probe_headers),
            FakeResponse(200, archive, {'Content-Type': 'application/octet-stream'}),
        ]

    def run_capture(self, *, archive=ARCHIVE, metadata=None, probe_status=206,
                    remaining=None, opener=None):
        opener = opener or FakeOpener(self.responses(archive=archive, metadata=metadata,
                                                     probe_status=probe_status))
        ledger = Ledger(self, self.root)
        if remaining is None:
            remaining = lambda: 30
        with mock.patch.object(M.urllib.request, 'build_opener', return_value=opener):
            result = M.capture_registry_original(
                source_sha=self.source_sha,
                lock_integrity=self.lock_integrity,
                name=NAME,
                version=VERSION,
                output=self.root,
                check=lambda: None,
                remaining_seconds=remaining,
                reserve=ledger.reserve,
                settle=ledger.settle,
            )
        return result, ledger, opener

    def test_successful_three_files_two_settles_exact_sha_and_no_cap_fact(self):
        result, ledger, opener = self.run_capture()

        self.assertEqual(len(result), 3)
        self.assertEqual([row['path'].rsplit('/', 1)[-1] for row in result],
                         ['archive.tgz', 'metadata.json', 'transport.json'])
        self.assertEqual(len(ledger.settled), 2)
        self.assertEqual(ledger.reserved, [2 * M.METADATA + 1, len(ARCHIVE)])

        archive_ref, metadata_ref, transport_ref = result
        self.assertEqual(ledger.settled[0][0], 'token-2')
        self.assertEqual(ledger.settled[0][1], [archive_ref])
        self.assertEqual(ledger.settled[1][0], 'token-1')
        self.assertEqual(ledger.settled[1][1], [metadata_ref, transport_ref])

        self.assertEqual(archive_ref['bytes'], len(ARCHIVE))
        self.assertEqual(archive_ref['sha256'], hashlib.sha256(ARCHIVE).hexdigest())
        self.assertEqual(metadata_ref['bytes'], len(self.metadata_body()))
        self.assertEqual(metadata_ref['sha256'], hashlib.sha256(self.metadata_body()).hexdigest())

        on_disk_metadata = json.loads((self.root / metadata_ref['path']).read_bytes())
        self.assertEqual(on_disk_metadata, {
            'name': NAME,
            'version': VERSION,
            'dist': {'integrity': self.lock_integrity, 'tarball': ARCHIVE_URL},
        })
        self.assertEqual(on_disk_metadata['dist']['tarball'], ARCHIVE_URL)
        self.assertEqual(on_disk_metadata['dist']['integrity'], self.lock_integrity)
        self.assertEqual(hashlib.sha512((self.root / archive_ref['path']).read_bytes()).digest(),
                         base64.b64decode(self.lock_integrity[7:]))

        receipt = json.loads((self.root / transport_ref['path']).read_bytes())
        expected_receipt = {
            'schemaVersion': 1,
            'kind': 'registry-build-input-transport',
            'sourceSha': self.source_sha,
            'url': ARCHIVE_URL,
            'status': 200,
            'completed': True,
            'bytes': len(ARCHIVE),
            'sha256': hashlib.sha256(ARCHIVE).hexdigest(),
        }
        self.assertEqual(receipt, expected_receipt)
        self.assertEqual(transport_ref['sha256'],
                         hashlib.sha256(json.dumps(expected_receipt, separators=(',', ':')).encode() + b'\n').hexdigest())
        self.assertNotIn('cap', receipt)
        self.assertNotIn('capability', json.dumps(receipt))
        self.assertNotIn('qualified', json.dumps(receipt))

        self.assertEqual([row['url'] for row in opener.requests], [METADATA_URL, ARCHIVE_URL, ARCHIVE_URL])
        self.assertEqual(opener.requests[0]['headers'].get('Accept-encoding'), 'identity')
        self.assertNotIn('Range', opener.requests[0]['headers'])
        self.assertEqual(opener.requests[1]['headers'].get('Range'), 'bytes=0-0')
        self.assertEqual(opener.requests[2]['headers'].get('Accept-encoding'), 'identity')
        self.assertNotIn('Range', opener.requests[2]['headers'])
        self.assertTrue(all(row['timeout'] == 30 for row in opener.requests))

    def test_wrong_actual_archive_sri_retains_reservations_and_no_transport(self):
        wrong = b'archive bytes that do not match the lock\n'
        ledger = Ledger(self, self.root)
        opener = FakeOpener(self.responses(archive=wrong))
        with mock.patch.object(M.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(ValueError, 'complete actual archive lock SRI'):
                M.capture_registry_original(
                    source_sha=self.source_sha,
                    lock_integrity=self.lock_integrity,
                    name=NAME,
                    version=VERSION,
                    output=self.root,
                    check=lambda: None,
                    remaining_seconds=lambda: 30,
                    reserve=ledger.reserve,
                    settle=ledger.settle,
                )

        self.assertEqual(ledger.reserved, [2 * M.METADATA + 1, len(wrong)])
        self.assertEqual(ledger.settled, [])
        directory = self.retained_directory()
        self.assertTrue((directory / 'archive.tgz').is_file())
        self.assertFalse((directory / 'transport.json').exists())

    def test_oversized_metadata_rejects_without_archive_transport(self):
        too_large = b'{' + b' ' * (M.METADATA + 1)
        ledger = Ledger(self, self.root)
        opener = FakeOpener(self.responses(metadata=too_large))
        with mock.patch.object(M.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(ValueError, 'retained original byte bound'):
                M.capture_registry_original(
                    source_sha=self.source_sha,
                    lock_integrity=self.lock_integrity,
                    name=NAME,
                    version=VERSION,
                    output=self.root,
                    check=lambda: None,
                    remaining_seconds=lambda: 30,
                    reserve=ledger.reserve,
                    settle=ledger.settle,
                )

        self.assertEqual(ledger.reserved, [2 * M.METADATA + 1])
        self.assertEqual(ledger.settled, [])
        self.assertEqual([row['url'] for row in opener.requests], [METADATA_URL])
        directory = self.retained_directory()
        self.assertFalse((directory / 'transport.json').exists())

    def test_non_206_probe_rejects_without_full_download(self):
        ledger = Ledger(self, self.root)
        opener = FakeOpener(self.responses(probe_status=200))
        with mock.patch.object(M.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(ValueError, 'exact one-byte range sizing required'):
                M.capture_registry_original(
                    source_sha=self.source_sha,
                    lock_integrity=self.lock_integrity,
                    name=NAME,
                    version=VERSION,
                    output=self.root,
                    check=lambda: None,
                    remaining_seconds=lambda: 30,
                    reserve=ledger.reserve,
                    settle=ledger.settle,
                )

        self.assertEqual(ledger.reserved, [2 * M.METADATA + 1])
        self.assertEqual(ledger.settled, [])
        self.assertEqual([row['url'] for row in opener.requests], [METADATA_URL, ARCHIVE_URL])
        self.assertEqual(opener.requests[1]['headers'].get('Range'), 'bytes=0-0')
        self.assertFalse(any('Range' not in row['headers'] and row['url'] == ARCHIVE_URL
                             for row in opener.requests))
        directory = self.retained_directory()
        self.assertFalse((directory / 'transport.json').exists())

    def test_deadline_exhaustion_fails_without_success(self):
        calls = []

        def remaining():
            calls.append(1)
            return 30 if len(calls) < 8 else 0

        ledger = Ledger(self, self.root)
        opener = FakeOpener(self.responses())
        with mock.patch.object(M.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(ValueError, 'shared deadline exhausted'):
                M.capture_registry_original(
                    source_sha=self.source_sha,
                    lock_integrity=self.lock_integrity,
                    name=NAME,
                    version=VERSION,
                    output=self.root,
                    check=lambda: None,
                    remaining_seconds=remaining,
                    reserve=ledger.reserve,
                    settle=ledger.settle,
                )

        self.assertEqual(ledger.settled, [])
        self.assertEqual(ledger.reserved, [2 * M.METADATA + 1])
        self.assertEqual(len(opener.requests), 1)
        self.assertEqual(opener.requests[0]['url'], METADATA_URL)
        directory = self.retained_directory()
        self.assertFalse((directory / 'transport.json').exists())
        self.assertFalse(any('completed' in path.name or 'receipt' in path.name
                             for path in directory.glob('*')))


class ClosedMetadataCustodyTests(unittest.TestCase):
    def test_actual_path_replacements_are_rejected_before_read(self):
        for kind in ('symlink', 'fifo', 'oversize', 'same_size_new_inode'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                file = root / 'metadata.json'
                body = b'{"name":"negotiate"}'
                file.write_bytes(body)
                identity = M.file_identity(file.lstat())
                ref = {'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}
                self.assertEqual(M.read_closed_original(file, ref, identity, lambda: None), body)
                file.rename(root / 'original')
                if kind == 'symlink':
                    file.symlink_to(root / 'original')
                elif kind == 'fifo':
                    M.os.mkfifo(file)
                elif kind == 'oversize':
                    with file.open('wb') as stream:
                        stream.truncate(M.METADATA + 1)
                else:
                    file.write_bytes(body)
                with mock.patch.object(M.os, 'read', side_effect=AssertionError('replaced path must not read')):
                    with self.assertRaisesRegex(ValueError, 'same bounded closed metadata identity'):
                        M.read_closed_original(file, ref, identity, lambda: None)


if __name__ == '__main__':
    unittest.main()
