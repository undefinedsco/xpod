"""Actual streaming codec tests: real child, real pipes, no Docker or network."""
import gzip
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    'service_runtime_stream', ROOT / 'qlever/scripts/sdk-service-runtime-stream.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

DATA = ROOT / '.test-data/service-source/runtime-codec'

CHILD = r'''
import hashlib, os, sys, time

seed, size, marker = sys.argv[1], int(sys.argv[2]), sys.argv[3]


def payload(seed, total):
    state = hashlib.sha256(seed.encode()).digest()
    chunks = []
    made = 0
    while made < total:
        state = hashlib.sha256(state).digest()
        chunks.append(state)
        made += len(state)
    return b''.join(chunks)[:total]


def stderr_blob(seed):
    repeat = int(os.environ.get('STDERR_REPEAT', '5'))
    return (b'stderr:' + seed.encode() + b':line\n') * repeat


data = payload(seed, size)
stderr = sys.stderr
with open(marker, 'wb') as marker_file:
    marker_file.write(str(os.getpid()).encode())

first = len(data) // 2
stderr.buffer.write(stderr_blob(seed)[:7])
sys.stderr.buffer.flush()
sys.stdout.buffer.write(data[:first])
sys.stdout.buffer.flush()
sys.stderr.buffer.write(stderr_blob(seed)[7:])
sys.stderr.buffer.flush()
sys.stdout.buffer.write(data[first:])
sys.stdout.buffer.flush()
time.sleep(float(os.environ.get('TAIL_SLEEP', '0')))
sys.exit(int(os.environ.get('CODE', '0')))
'''


def payload(seed, total):
    state = hashlib.sha256(seed.encode()).digest()
    chunks = []
    made = 0
    while made < total:
        state = hashlib.sha256(state).digest()
        chunks.append(state)
        made += len(state)
    return b''.join(chunks)[:total]


def stderr_blob(seed):
    repeat = int(os.environ.get('STDERR_REPEAT', '5'))
    return (b'stderr:' + seed.encode() + b':line\n') * repeat


class RuntimeStreamTests(unittest.TestCase):
    def setUp(self):
        DATA.mkdir(parents=True, exist_ok=True)

    def run_child(self, seed, size, *limits, check=None, code='0', tail_sleep='0'):
        self.directory = tempfile.TemporaryDirectory(dir=DATA)
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        marker = root / 'child.pid'
        command = ['python3', '-c', CHILD, seed, str(size), str(marker)]
        environment = dict(os.environ, CODE=code, TAIL_SLEEP=tail_sleep)
        stdout, stderr = io.BytesIO(), io.BytesIO()
        with patch.dict(os.environ, environment):
            result = module.encode_process(
                command, stdout, stderr, limits[0], check or (lambda: None))
        return result, stdout.getvalue(), stderr.getvalue(), marker

    def assert_reaped(self, marker):
        deadline = time.monotonic() + 5
        while not marker.exists():
            if time.monotonic() > deadline:
                self.fail('child start marker never appeared')
            time.sleep(0.01)
        pid = int(marker.read_text())
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        self.fail(f'owned child {pid} was left running or unreaped')

    def test_concatenated_blocks_preserve_raw_bytes_and_both_hashes(self):
        seed, size = 'tar-like', 300_000
        result, encoded, stderr, marker = self.run_child(seed, size, 2 * 1024 * 1024)
        raw = payload(seed, size)

        self.assertEqual(gzip.decompress(encoded), raw)
        self.assertEqual(result['expanded'], {
            'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
        self.assertEqual(result['encoded'], {
            'bytes': len(encoded), 'sha256': hashlib.sha256(encoded).hexdigest()})
        self.assertEqual(result['blocks'][-1]['offset'] + result['blocks'][-1]['bytes'],
                         len(encoded))
        self.assertEqual(sum(block['bytes'] for block in result['blocks']), len(encoded))
        self.assertEqual(len(result['blocks']),
                         (len(raw) + module.CODEC.LIMITS['rangeBytes'] - 1)
                         // module.CODEC.LIMITS['rangeBytes'])

        expanded_offset = encoded_offset = 0
        for block in result['blocks']:
            self.assertEqual(block['offset'], encoded_offset)
            self.assertEqual(block['expandedOffset'], expanded_offset)
            self.assertLessEqual(block['expandedBytes'], 64 * 1024)
            member = encoded[block['offset']:block['offset'] + block['bytes']]
            self.assertEqual(len(gzip.decompress(member)), block['expandedBytes'])
            expanded_offset += block['expandedBytes']
            encoded_offset += block['bytes']
        self.assertEqual(expanded_offset, len(raw))

        expected_stderr = stderr_blob(seed)
        self.assertEqual(stderr, expected_stderr)
        process = result['process']
        self.assertEqual(process['command'][-3:], [seed, str(size), str(marker)])
        self.assertIsInstance(process['pid'], int)
        self.assertEqual(process['exit'], 0)
        self.assertTrue(process['actualWait'])
        self.assertTrue(process['stdoutEof'])
        self.assertTrue(process['stderrEof'])
        self.assertEqual(process['stderrBytes'], len(expected_stderr))
        self.assertEqual(process['stderrSha256'], hashlib.sha256(expected_stderr).hexdigest())
        self.assert_reaped(marker)

    def test_malformed_source_bytes_are_only_transported(self):
        seed, size = 'not-a-tar-plain-bytes', 70_000
        result, encoded, _, marker = self.run_child(seed, size, 2 * 1024 * 1024)
        raw = payload(seed, size)
        self.assertFalse(hasattr(module, 'tarfile'))
        self.assertEqual(gzip.decompress(encoded), raw)
        self.assertEqual(result['expanded']['sha256'], hashlib.sha256(raw).hexdigest())

    def test_nonzero_child_exit_rejected_after_reaping(self):
        with self.assertRaisesRegex(ValueError, 'child exit 7'):
            self.run_child('exit-child', 10_000, 2 * 1024 * 1024, code='7')

    def test_encoded_limit_rejected_before_exceeding_write_and_child_reaped(self):
        sink = io.BytesIO()
        stderr = io.BytesIO()
        with tempfile.TemporaryDirectory(dir=DATA) as directory:
            marker = Path(directory) / 'child.pid'
            command = ['python3', '-c', CHILD, 'bound', str(2 * 1024 * 1024), str(marker)]
            with self.assertRaisesRegex(ValueError, 'encoded bound'):
                module.encode_process(command, sink, stderr, 1024, lambda: None)
            self.assertLessEqual(len(sink.getvalue()), 1024)
            self.assert_reaped(marker)

    def test_logical_bound_rejected_and_child_reaped(self):
        with tempfile.TemporaryDirectory(dir=DATA) as directory:
            marker = Path(directory) / 'child.pid'
            command = ['python3', '-c', CHILD, 'logical', '100000', str(marker)]
            with patch.object(module.CODEC, 'ARCHIVE_LIMIT', 4096):
                with self.assertRaisesRegex(ValueError, 'expanded archive bound'):
                    module.encode_process(command, io.BytesIO(), io.BytesIO(),
                                          2 * 1024 * 1024, lambda: None)
            self.assert_reaped(marker)

    def test_inherited_check_exception_is_preserved_and_child_reaped(self):
        with tempfile.TemporaryDirectory(dir=DATA) as directory:
            marker = Path(directory) / 'child.pid'
            command = ['python3', '-c', CHILD, 'checked', str(1024 * 1024), str(marker)]
            environment = dict(os.environ, TAIL_SLEEP='0.5', CODE='0')
            started = time.monotonic()

            class InheritedCheckFailure(Exception):
                pass

            failure = InheritedCheckFailure('caller check failed')

            def check():
                if marker.exists():
                    raise failure
                if time.monotonic() - started > 10:
                    raise AssertionError('child start marker never observed')

            with patch.dict(os.environ, environment):
                with self.assertRaises(InheritedCheckFailure) as caught:
                    module.encode_process(command, io.BytesIO(), io.BytesIO(),
                                          2 * 1024 * 1024, check)
            self.assertIs(caught.exception, failure)
            self.assert_reaped(marker)

    def test_stderr_metadata_bound_rejected_and_child_reaped(self):
        with tempfile.TemporaryDirectory(dir=DATA) as directory:
            marker = Path(directory) / 'child.pid'
            command = ['python3', '-c', CHILD, 'stderr-bound', str(1024), str(marker)]
            environment = dict(os.environ, STDERR_REPEAT='200', CODE='0')
            with patch.dict(os.environ, environment):
                with patch.dict(module.CODEC.LIMITS, {'metadataBytes': 16}):
                    with self.assertRaisesRegex(ValueError, 'stderr metadata bound'):
                        module.encode_process(command, io.BytesIO(), io.BytesIO(),
                                              2 * 1024 * 1024, lambda: None)
            self.assert_reaped(marker)

    def test_actual_cli_runtime_role_encodes_without_raw_tar_file(self):
        import subprocess, sys
        with tempfile.TemporaryDirectory(dir=DATA) as directory:
            directory = Path(directory);docker = directory/'docker'
            docker.write_text('#!'+sys.executable+'\nimport os,sys\nassert sys.argv[1:4]==["--host","unix:///var/run/docker.sock","cp"]\nos.write(1,b"actual payload"*100000)\nos.write(2,b"actual child stderr")\n')
            docker.chmod(0o755)
            command=[sys.executable,str(ROOT/'qlever/scripts/sdk-service-image-originals.py'),'--source',str(ROOT),'--source-sha','a'*40,'--image-worker','copy-runtime-app','--service-image','ghcr.io/undefinedsco/xpod@sha256:'+'b'*64,'--container-name','xpod-service-output-'+'d'*32,'--owner-nonce','d'*32,'--container-id','c'*64,'--copy-byte-bound',str(1024*1024)]
            result=subprocess.run(command,env={**os.environ,'PATH':str(directory)+os.pathsep+os.environ.get('PATH','')},capture_output=True,timeout=10)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(gzip.decompress(result.stdout),b'actual payload'*100000)
            marker=b'\nXPOD_RUNTIME_GZIP_BLOCKS_V1\n';prefix,encoded=result.stderr.rsplit(marker,1)
            import json
            state=json.loads(encoded);self.assertEqual(prefix,b'actual child stderr');self.assertTrue(state['process']['actualWait']);self.assertTrue(state['process']['stdoutEof']);self.assertTrue(state['process']['stderrEof']);self.assertEqual(state['encoded']['sha256'],hashlib.sha256(result.stdout).hexdigest())
            self.assertEqual(sorted(p.name for p in directory.iterdir()),['docker'])

    def test_none_writer_does_not_claim_bytes_were_written(self):
        class Sink:
            def write(self, data):return None
        with self.assertRaisesRegex(OSError,'no progress'):
            module._write_all(Sink(),b'actual',lambda:None)


if __name__ == '__main__':
    unittest.main()
