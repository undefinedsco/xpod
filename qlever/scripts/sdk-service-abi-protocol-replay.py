"""Replay original protocol bytes through the sole shared smoke implementation.

No process is started and no process exit, source or release qualification is
issued. The caller must independently authenticate the source and actual wait.
"""
import json


def replay_shared_smoke(helper, stdin, stdout, stderr, expected_abi, check):
    if any(type(body) is not bytes or len(body) > 1024 * 1024 for body in (stdin, stdout, stderr)):
        raise ValueError('bounded complete protocol originals required')
    keys = {'abiVersion', 'adapterAbiVersion', 'physicalBackendAbiVersion'}
    if set(expected_abi) != keys or any(type(value) is not int or value <= 0 for value in expected_abi.values()):
        raise ValueError('source-derived ABI axes required')
    expected_abi = dict(expected_abi)
    lines = stdout.splitlines(keepends=True)
    if not lines or any(not line.endswith(b'\n') for line in lines):
        raise ValueError('complete protocol lines required')

    def unique_object(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("duplicate protocol key")
            value[key] = item
        return value

    class Replay:
        def __init__(self):
            self.stdin = self.stdout = self
            self.returncode = None
            self.written = self.read = self.requests = 0
            self.pending = False

        def write(self, value):
            check()
            encoded = value.encode('utf8')
            if self.pending or stdin[self.written:self.written + len(encoded)] != encoded:
                raise ValueError('shared request differs from original input')
            self.written += len(encoded)
            self.requests += 1
            self.pending = True
            return len(value)

        def flush(self):
            check()

        def read_protocol_line(self):
            check()
            if self.read >= len(lines) or (self.read and not self.pending):
                raise ValueError('missing or causally unbound response')
            raw = lines[self.read]
            message = json.loads(raw, object_pairs_hook=unique_object)
            if self.read == 0:
                ready = message
                if ready.get('type') != 'ready' or any(type(ready.get(key)) is not int or ready[key] != value for key, value in expected_abi.items()):
                    raise ValueError('ready ABI differs from source declarations')
            self.read += 1
            self.pending = False
            return raw.decode('utf8')

        def kill(self):
            raise ValueError('shared smoke rejected original response')

        def communicate(self, timeout=None):
            check()
            if self.written != len(stdin) or self.read != len(lines):
                raise ValueError('unconsumed original protocol bytes')
            self.returncode = 0  # Replay completion only; never an actual wait.
            return '', stderr.decode('utf8')

    process = Replay()
    result = helper._run_runtime_smoke_session(process)
    check()
    if result != (expected_abi['adapterAbiVersion'], expected_abi['physicalBackendAbiVersion']):
        raise ValueError('shared smoke ABI result differs')
    return dict(adapterAbiVersion=result[0], physicalBackendAbiVersion=result[1],
                inputBytes=process.written, outputLines=process.read, requests=process.requests,
                scope='original-byte replay only; actual wait and source authority independent')
