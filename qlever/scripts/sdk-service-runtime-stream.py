"""Stream one owned child's stdout through the existing gzip block codec.

Byte transport only: the raw stdout bytes are never interpreted, staged in a
tar file, or written to an encoded second file.  ``module-source-materials``
is reused through importlib for the concatenated gzip blocks and their
expanded SHA/count bookkeeping.  The caller owns the overall deadline/budget
and supplies ``check``; this module adds no timer or budget of its own.
"""
import hashlib
import importlib.util
import os
from pathlib import Path
import selectors
import subprocess
import time


ROOT = Path(__file__).resolve().parents[2]
CODEC_PATH = ROOT / 'scripts/lib/module-source-materials.py'
CHUNK_BYTES = 65536
SELECT_TIMEOUT = 0.05


def _load_codec():
    spec = importlib.util.spec_from_file_location('service_runtime_source_materials', CODEC_PATH)
    if spec is None or spec.loader is None:
        raise ImportError('existing source gzip block codec is unavailable')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CODEC = _load_codec()
GzipBlockWriter = CODEC.GzipBlockWriter


def _write_all(stream, data, check):
    """Write every byte of one bounded chunk, checking before each write."""
    view = memoryview(data)
    while view:
        check()
        count = stream.write(view)
        if count is None:
            raise OSError('runtime stream sink made no progress')
        if count <= 0:
            raise OSError('runtime stream sink made no progress')
        view = view[count:]


class _LimitedWriter:
    """Count and hash encoded bytes, rejecting the write before it exceeds."""

    def __init__(self, stream, limit, check):
        self.stream = stream
        self.limit = limit
        self.check = check
        self.count = 0
        self.sha256 = hashlib.sha256()

    def write(self, data):
        self.check()
        data = bytes(data)
        if self.count + len(data) > self.limit:
            raise ValueError('runtime stream encoded bound')
        _write_all(self.stream, data, self.check)
        self.count += len(data)
        self.sha256.update(data)
        flush = getattr(self.stream, 'flush', None)
        if flush is not None:
            self.check()
            flush()
        return len(data)

    def tell(self):
        return self.count


def _command(command):
    if isinstance(command, (str, bytes)) or not isinstance(command, (list, tuple)) or not command:
        raise TypeError('runtime stream command must be a nonempty argv sequence')
    argv = list(command)
    if any(not isinstance(part, str) or not part for part in argv):
        raise ValueError('runtime stream command needs nonempty text arguments')
    return argv


def _read(fd, size):
    try:
        return os.read(fd, size)
    except BlockingIOError:
        return None


def _wait(process, check):
    """Wait for the natural exit, polling only under the caller's check."""
    while process.poll() is None:
        check()
        time.sleep(SELECT_TIMEOUT)
    return process.returncode


def _cleanup(process, selector):
    """Kill and reap only our own child; never replace the primary error."""
    if selector is not None:
        try:
            selector.close()
        except BaseException:
            pass
    if process is None:
        return
    try:
        if process.poll() is None:
            process.kill()
    except BaseException:
        pass
    try:
        # SIGKILL was delivered to our own child; bound the reap so cleanup
        # can never become an unbounded wait that hides the primary failure.
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    except BaseException:
        pass
    for name in ('stdout', 'stderr'):
        stream = getattr(process, name, None)
        if stream is not None:
            try:
                stream.close()
            except BaseException:
                pass


def encode_process(command, stdout, stderr, encoded_limit, check):
    """Run ``command`` and stream its stdout as concatenated gzip blocks.

    Returns only after the child was naturally waited for with exit 0 and both
    pipes reached EOF.  Nonzero exit, encoded/logical/metadata bounds, and IO
    or callback failures are rejected.
    """
    argv = _command(command)
    if type(encoded_limit) is not int or encoded_limit < 1:
        raise ValueError('positive encoded byte bound required')
    if not callable(check):
        raise TypeError('check callback required')
    for name, stream in (('stdout', stdout), ('stderr', stderr)):
        if stream is None or not callable(getattr(stream, 'write', None)):
            raise TypeError(f'binary {name} sink required')

    process = None
    selector = None
    eofs = set()
    stderr_bytes = 0
    stderr_sha256 = hashlib.sha256()
    limited = _LimitedWriter(stdout, encoded_limit, check)
    encoded = GzipBlockWriter(limited)
    metadata_limit = CODEC.LIMITS['metadataBytes']

    try:
        check()
        process = subprocess.Popen(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
            close_fds=True,
        )
        selector = selectors.DefaultSelector()
        for role in ('stdout', 'stderr'):
            stream = getattr(process, role)
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, role)

        while len(eofs) < 2:
            check()
            for key, _ in selector.select(SELECT_TIMEOUT):
                check()
                role = key.data
                if role == 'stderr':
                    room = metadata_limit - stderr_bytes + 1
                    block = _read(key.fd, min(CHUNK_BYTES, room))
                else:
                    block = _read(key.fd, CHUNK_BYTES)
                if block is None:
                    continue
                if not block:
                    eofs.add(role)
                    selector.unregister(key.fileobj)
                    continue
                if role == 'stdout':
                    encoded.write(block)
                else:
                    if stderr_bytes + len(block) > metadata_limit:
                        raise ValueError('runtime stream stderr metadata bound')
                    _write_all(stderr, block, check)
                    stderr_sha256.update(block)
                    stderr_bytes += len(block)

        check()
        encoded.finish()
        exit_code = _wait(process, check)
        if exit_code != 0:
            raise ValueError(f'runtime stream child exit {exit_code}')

        return {
            'expanded': {
                'bytes': encoded.expanded_bytes,
                'sha256': encoded.expanded_sha.hexdigest(),
            },
            'blocks': encoded.blocks,
            'encoded': {
                'bytes': limited.count,
                'sha256': limited.sha256.hexdigest(),
            },
            'process': {
                'command': argv,
                'pid': process.pid,
                'exit': exit_code,
                'actualWait': True,
                'stdoutEof': True,
                'stderrEof': True,
                'stderrBytes': stderr_bytes,
                'stderrSha256': stderr_sha256.hexdigest(),
            },
        }
    finally:
        _cleanup(process, selector)
