"""Actual producer runtime-capture node, driven by a fake docker transport.

This exercises the real qlever/scripts/sdk-service-image-originals.py stage:
same owned pulled/created/inspected container, one extra /app and one extra
native /opt/xpod/qlever `docker cp <cid>:<root> -` stage before removal, bounded
scan of the actual stdout tar, and an offset/link index of that same held
original. No copied tar shards exist.
No Docker, no syft/Bun, no network; the only fake is the outer command executor.
"""
import hashlib
import gzip
import importlib.util
import io
import json
import posixpath
import tarfile
import tempfile
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    'runtime_capture_producer', ROOT / 'qlever/scripts/sdk-service-image-originals.py')
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


def ref(path, body):
    return dict(path=path, bytes=len(body), sha256=hashlib.sha256(body).hexdigest())


def build_tar(root, rows):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for name, kind, body, link in rows:
            info = tarfile.TarInfo((root + '/' if root else '') + name)
            if kind == 'file':
                info.type = tarfile.REGTYPE
                info.size = len(body)
                info.mode = 0o644
                archive.addfile(info, io.BytesIO(body))
            elif kind == 'directory':
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                archive.addfile(info)
            elif kind == 'symlink':
                info.type = tarfile.SYMTYPE
                info.linkname = link
                info.mode = 0o777
                archive.addfile(info)
            else:
                raise ValueError(kind)
    return raw.getvalue()


APP_ROWS = [
    ('', 'directory', b'', None),
    ('package.json', 'file', b'{"name":"@undefineds.co/xpod","version":"1.2.3"}', None),
    ('dist', 'directory', b'', None),
    ('dist/index.js', 'file', b'exports.actual = 1;\n', None),
    ('provenance', 'directory', b'', None),
    ('provenance/service-pack-originals', 'directory', b'', None),
    ('node_modules/@undefineds.co/xpod', 'symlink', b'', '/app'),
    ('node_modules/.bin/xpod', 'symlink', b'', '../../@undefineds.co/xpod/bin/xpod.js'),
]
SDK_ROWS = [
    ('', 'directory', b'', None),
    ('bin/qlever', 'file', b'\x7fELF actual native sdk bytes\n', None),
    ('lib/libqlever.so', 'file', b'actual shared object bytes\n', None),
]


class Budget:
    def check(self, *args):
        pass

    def timeout(self, cap, *args):
        return cap


class RuntimeCaptureTests(unittest.TestCase):
    def setUp(self):
        parent = ROOT / '.test-data'
        parent.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.out = self.root / 'case'
        self.sha = 'f' * 40
        self.cid = 'c' * 64
        self.nonce = 'd' * 32
        self.image = 'ghcr.io/undefinedsco/xpod@sha256:' + 'a' * 64
        self.config = 'sha256:' + 'b' * 64
        self.calls = []
        self.stdout = {}
        self.app = build_tar('app', APP_ROWS)
        self.sdk = build_tar('qlever', SDK_ROWS)
        self.limits = M.LIMITS
        self.codec_mutation = lambda state: None

    def fresh(self):
        self.out = Path(tempfile.mkdtemp(dir=self.root))
        self.calls = []
        self.stdout = {}

    def capture(self, label, argv, *args, **kwargs):
        role = argv[argv.index('--image-worker') + 1]
        self.calls.append(role)
        if role == 'pull':
            body = b'pulled'
        elif role in ('create', 'remove'):
            body = (self.cid + '\n').encode()
        elif role in ('confirm-absent', 'cleanup-confirm-absent'):
            body = b''
        elif role == 'inspect':
            body = json.dumps(dict(
                Id=self.cid, Image=self.config, Name='/xpod-service-output-' + self.nonce,
                Config=dict(Image=self.image, Labels={M.OUTPUT_LABEL: self.nonce}),
                State=dict(Running=False, Status='created', Pid=0,
                           StartedAt='0001-01-01T00:00:00Z'))).encode()
        elif role == 'copy':
            body = build_tar('', [('package.json', 'file',
                                   b'{"name":"@undefineds.co/xpod","version":"1.2.3"}', None)])
        elif role == 'copy-runtime-app':
            body = self.app
        elif role == 'copy-runtime-sdk':
            body = self.sdk
        else:
            raise ValueError(role)
        stderr_body = b''
        if role in ('copy-runtime-app', 'copy-runtime-sdk'):
            codec = M.load('sdk-service-runtime-stream');sink = io.BytesIO();writer = codec._LimitedWriter(sink, 32*M.META, lambda: None);encoder = codec.GzipBlockWriter(writer);encoder.write(body);encoder.finish();body = sink.getvalue()
            state = dict(expanded=dict(bytes=encoder.expanded_bytes,sha256=encoder.expanded_sha.hexdigest()),blocks=encoder.blocks,encoded=dict(bytes=len(body),sha256=hashlib.sha256(body).hexdigest()),process=dict(command=M.output_image_command(role,self.image,'xpod-service-output-'+self.nonce,self.nonce,self.cid),pid=123,exit=0,actualWait=True,stdoutEof=True,stderrEof=True,stderrBytes=0,stderrSha256=hashlib.sha256(b'').hexdigest()))
            self.codec_mutation(state)
            stderr_body = M.RUNTIME_CODEC_MARKER + json.dumps(state).encode() + b'\n'
        self.stdout[role] = body
        row = dict(name=label, inputs=[], outputs=[])
        directory = self.out / 'stages' / label
        directory.mkdir(parents=True)
        for key in ['receipt', 'stdout', 'stderr', 'supervisionReceipt', 'supervisionRaw']:
            filename = ('stdout.raw' if key == 'stdout' else key + '.json')
            data = body if key == 'stdout' else stderr_body if key == 'stderr' else json.dumps({'command':argv}).encode() if key == 'receipt' else b'{}'
            path = directory / filename
            path.write_bytes(data)
            row[key] = ref(path.relative_to(self.out).as_posix(), data)
        return row

    def observe(self):
        with patch.object(M.secrets, 'token_hex', return_value=self.nonce), \
                patch.object(M.outer.commands, 'capture', side_effect=self.capture):
            return M.observe_output_image(self.image, self.config, M.Retained(self.out, Budget()),
                                          self.out, self.sha, capture_runtime_members=True)

    def test_native_locator_optional_exact_same_capture_identity(self):
        sdk='ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:'+'a'*64
        local='ghcr.io/undefinedsco/xpod-qlever-local-runtime@sha256:'+'b'*64
        args=SimpleNamespace(source_sha=self.sha)
        self.assertIsNone(M.native_runtime_locator(args,123,2,sdk,local))
        args.native_runtime_artifact_id=77
        with self.assertRaises(ValueError):M.native_runtime_locator(args,123,2,sdk,local)
        args.native_runtime_artifact_digest='c'*64
        args.native_runtime_master_bytes=123
        args.native_runtime_master_sha256='d'*64
        value=M.native_runtime_locator(args,123,2,sdk,local)
        self.assertEqual(value,dict(artifactId=77,artifactSha256='c'*64,sourceSha=self.sha,runId=123,runAttempt=2,target='linux-x64',sdkProfile='service-trixie',sdkImageReferenceByDigest=sdk,localRuntimeImageReferenceByDigest=local,master=dict(path='materials.json',bytes=123,sha256='d'*64)))
        for name,bad in [('native_runtime_artifact_id',True),('native_runtime_master_bytes',M.META+1),('native_runtime_artifact_digest','bad')]:
            previous=getattr(args,name);setattr(args,name,bad)
            with self.assertRaises(ValueError):M.native_runtime_locator(args,123,2,sdk,local)
            setattr(args,name,previous)

    def test_reject_unclosed_or_mismatched_actual_child_codec(self):
        mutations = [
            lambda s: s['process'].update(exit=False),
            lambda s: s['process'].update(actualWait=False),
            lambda s: s['process'].update(stdoutEof=False),
            lambda s: s['process'].update(stderrEof=False),
            lambda s: s['process'].update(extra=True),
            lambda s: s['process'].update(command=['docker', 'unrelated']),
            lambda s: s['encoded'].update(sha256='0' * 64),
            lambda s: s['expanded'].update(sha256='0' * 64),
            lambda s: s['blocks'][0].update(expandedOffset=1),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutations.index(mutation)):
                self.fresh()
                self.codec_mutation = mutation
                with self.assertRaises(ValueError):
                    self.observe()

    def test_one_owned_container_extra_app_and_native_stages_precede_remove(self):
        _, result = self.observe()
        self.assertEqual(self.calls, ['pull', 'create', 'inspect', 'copy',
                                      'copy-runtime-app', 'copy-runtime-sdk',
                                      'remove', 'confirm-absent'])
        runtime = result['runtimeMemberObservation']
        self.assertEqual(runtime['kind'], 'actual-stopped-service-image-runtime-roots')
        self.assertEqual(runtime['containerId'], self.cid)
        self.assertEqual([row['targetRoot'] for row in runtime['roots']], ['/app', '/opt/xpod/qlever'])
        self.assertEqual(len(result['stages']), 6)
        roots = {row['targetRoot']: row for row in runtime['roots']}
        self.assertTrue(roots['/app']['evidencePayloadInventoried'])
        self.assertFalse(roots['/app']['sourceCoverageInferred'])
        self.assertFalse(roots['/app']['wholeServiceSourceVerified'])
        index = json.loads((self.out / roots['/app']['index']['path']).read_bytes())
        self.assertEqual(index['kind'], 'actual-service-image-runtime-members-v1')
        self.assertEqual(index['containerId'], self.cid)
        self.assertEqual(index['configDigest'], self.config)
        self.assertIn('provenance', index['evidencePayloadPaths'])
        symlinks = {row['path']: row for row in index['members'] if row['type'] == 'symlink'}
        self.assertEqual(symlinks['node_modules/@undefineds.co/xpod']['target'], '/app')
        self.assertEqual(len(symlinks), 2)
        self.assertIn('node_modules/.bin/xpod', symlinks)
        # The index references the actual stage stdout original, not copies.
        self.assertEqual(index['archive'], roots['/app']['archive'])
        self.assertIn('copy-runtime-app/stdout.raw', index['archive']['path'])
        self.assertEqual(self.stdout['copy-runtime-app'],
                         (self.out / index['archive']['path']).read_bytes())
        self.assertEqual(hashlib.sha256(self.stdout['copy-runtime-app']).hexdigest(),
                         index['archive']['sha256'])
        self.assertNotIn('shards', index['archive'])
        self.assertFalse(list((self.out / 'output/service-runtime-members').rglob('tar-*')))
        # Members keep exact tar data offsets for 64KiB range reads.
        expected = {name: body for name, kind, body, _ in APP_ROWS if kind == 'file'}
        files = {row['path']: row for row in index['members'] if row['type'] == 'file'}
        self.assertEqual(set(files), set(expected))
        for name, row in files.items():
            start = row['offset']
            self.assertEqual(gzip.decompress(self.stdout['copy-runtime-app'])[start:start + row['bytes']],
                             expected[name])
        # Fixed original limits/read window remain authoritative.
        self.assertTrue(all(self.limits['rangeBytes'] <= 65536 for _ in [0]))
        self.assertLessEqual(self.limits['metadataBytes'], self.limits['shardBytes'])

    def test_symlink_escape_duplicate_and_special_members_fail_closed(self):
        _, result = self.observe()
        index = json.loads((self.out / result['runtimeMemberObservation']['roots'][0]['index']['path']).read_bytes())
        for row in [row for row in index['members'] if row['type'] == 'symlink']:
            # Canonical path: absolute self-links stay /app, relative links stay inside it.
            target = row['target'] if row['target'].startswith('/') else posixpath.normpath(
                posixpath.join('/app', posixpath.dirname(row['path']), row['target']))
            self.assertTrue(target == '/app' or target.startswith('/app/'))
        for rows, message in [
            ([('', 'directory', b'', None), ('escape', 'symlink', b'', '/etc/passwd')], 'escapes'),
            ([('', 'directory', b'', None), ('same', 'file', b'x', None),
              ('same', 'file', b'x', None)], 'duplicate'),
        ]:
            self.fresh()
            self.app = build_tar('app', rows)
            with self.assertRaisesRegex(ValueError, message):
                self.observe()
            self.assertIn('cleanup-remove', self.calls)

    def test_requires_two_zero_eof_blocks_and_zero_trailer(self):
        raw = build_tar('app', [('', 'directory', b'', None), ('file', 'file', b'x', None)])
        # Two headers plus the regular file's padded body, before tarfile padding.
        end = 3 * 512
        for suffix in (b'', bytes(512), bytes(1024) + b'x'):
            candidate = self.root / 'eof.tar'
            candidate.write_bytes(raw[:end] + suffix)
            with self.assertRaisesRegex(ValueError, 'EOF|trailing'):
                M.scan_runtime_tar(candidate, '/app', 'app', lambda: None)
        for suffix in (bytes(1024), bytes(2048)):
            candidate.write_bytes(raw[:end] + suffix)
            rows, archive_sha, _ = M.scan_runtime_tar(candidate, '/app', 'app', lambda: None)
            self.assertEqual(len(rows), 2)
            self.assertEqual(archive_sha, hashlib.sha256(candidate.read_bytes()).hexdigest())

    def test_member_and_byte_budgets_are_shared_and_bounded(self):
        self.app = build_tar('app', [('', 'directory', b'', None)] +
                             [(f'f{index}', 'file', b'x', None) for index in range(5)])
        with patch.object(M, 'LIMITS', dict(self.limits, members=4)):
            with self.assertRaisesRegex(ValueError, 'member count'):
                self.observe()
        # No material universe: runtime cp is bounded by the one 32*META ledger.
        retained = M.Retained(self.out, Budget())
        self.assertFalse(hasattr(retained, 'material'))
        self.assertFalse(hasattr(retained, 'reserve_material'))
        self.assertFalse(hasattr(retained, 'settle_material'))
        bound = M.shared_runtime_cp_bound(retained, len(M.RUNTIME_ROOTS))
        self.assertGreater(bound, 0)
        self.assertLessEqual(retained.total + 2 * bound * len(M.RUNTIME_ROOTS)
                             + 3 * M.META * len(M.RUNTIME_ROOTS) + M.RUNTIME_CLEANUP_ROOM,
                             32 * M.META)
        # The runtime tar scan/inventory itself cannot exceed the same ledger.
        self.assertEqual(M.RUNTIME_CLEANUP_ROOM, 14 * M.META)
        retained.reserve(4 * M.META)
        self.assertLess(M.shared_runtime_cp_bound(retained, 2), bound)
        retained.total = 32 * M.META - M.RUNTIME_CLEANUP_ROOM
        with self.assertRaisesRegex(ValueError, 'remaining budget unavailable'):
            M.shared_runtime_cp_bound(retained, 1)


if __name__ == '__main__':
    unittest.main()
