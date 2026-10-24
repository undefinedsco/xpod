"""Streaming writer for the lossless kernel-raw-gzip-v1 wire container.

The container is exactly one gzip member (zlib gzip wrapper, wbits=31) whose
inflated bytes are the concatenated, unmodified LF-terminated wire rows.
Logical and encoded bytes are accounted separately.  The caller's existing
ledger is the only budget; this module only enforces the supplied maxima.
"""
import hashlib
import os
import stat
import zlib

MODEL = 'kernel-raw-gzip-v1'
CHUNK = 65536
FEED = 32768


class RawWireError(ValueError):
    """The raw wire stream or writer state is invalid."""


def _nonnegative(name, value):
    if type(value) is not int or value < 0:
        raise RawWireError(name + ' must be a nonnegative integer')
    return value


def _positive(name, value):
    if type(value) is not int or value < 1:
        raise RawWireError(name + ' must be a positive integer')
    return value


class RawWriter:
    """Write one gzip member directly to a new exclusive regular file.

    ``check`` is the full live validation callback. ``record_check`` is an
    optional cheaper refusal (deadline/stdio only) used for the pure-local
    compression/write iterations of one already-bracketed record; it never
    replaces the entry/exit ``check`` calls.
    """

    def __init__(self, path, *, claim, check, maximum_logical,
                 maximum_encoded, maximum_record=65536, record_check=None):
        if not callable(claim) or not callable(check) or (
                record_check is not None and not callable(record_check)):
            raise RawWireError('claim and check callbacks are required')
        self._claim = claim
        self._check_callback = check
        self._record_check_callback = record_check or check
        self.maximum_logical = _nonnegative('maximum_logical', maximum_logical)
        self.maximum_encoded = _nonnegative('maximum_encoded', maximum_encoded)
        self.maximum_record = _positive('maximum_record', maximum_record)
        self._path = os.fspath(path)
        self._fd = None
        self._compressor = None
        self._failure = None
        self._closed = False
        self._finished = False
        self._aborted = False
        self._logical = hashlib.sha256()
        self._encoded = hashlib.sha256()
        self._logical_bytes = 0
        self._encoded_bytes = 0
        self._records = 0

        compressor = zlib.compressobj(level=6, method=zlib.DEFLATED,
                                      wbits=31)
        flags = (os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                 getattr(os, 'O_CLOEXEC', 0) | getattr(os, 'O_NOFOLLOW', 0))
        try:
            fd = os.open(self._path, flags, 0o600)
        except BaseException:
            self._failure = 'raw wire path was not newly created'
            raise
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise RawWireError('raw wire path must be a regular file')
            if info.st_size != 0:
                raise RawWireError('raw wire path must start empty')
            self._fd = fd
            self._compressor = compressor
        except BaseException:
            self._failure = 'raw wire path is not a usable new regular file'
            try:
                os.close(fd)
            except OSError:
                pass
            raise

    @property
    def path(self):
        return self._path

    def _ready(self):
        if self._failure is not None:
            raise RawWireError(self._failure)
        if self._closed or self._finished or self._aborted:
            raise RawWireError('raw writer is already closed')
        if self._fd is None or self._compressor is None:
            raise RawWireError('raw writer is not open')

    def _check(self):
        self._check_callback()

    def _record_check(self):
        self._record_check_callback()

    def _fail(self, reason):
        if self._failure is None:
            self._failure = str(reason)
        fd, self._fd = self._fd, None
        self._compressor = None
        self._closed = True
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass

    def _reject(self, reason):
        self._fail(reason)
        raise RawWireError(reason)

    def _write_all(self, data):
        view = memoryview(data)
        while view:
            written = os.write(self._fd, view)
            if type(written) is not int or written <= 0 or written > len(view):
                raise RawWireError('raw wire write made no bounded progress')
            view = view[written:]

    def _emit_encoded(self, output, *, bracketed=False):
        if not output:
            return
        check = self._record_check if bracketed else self._check
        for offset in range(0, len(output), CHUNK):
            block = output[offset:offset + CHUNK]
            check()
            if self._encoded_bytes + len(block) > self.maximum_encoded:
                raise RawWireError('encoded raw wire byte bound exceeded')
            # Charge the exact retained range before the first byte of it can
            # appear in the file.  A later short write can only overcharge.
            self._claim(len(block))
            check()
            self._write_all(block)
            self._encoded.update(block)
            self._encoded_bytes += len(block)
            check()

    def write_record(self, raw, *, bracketed=False):
        """Append one exact LF-terminated row without reinterpreting it.

        ``bracketed=True`` means the caller already validated at the entry and
        will validate again at its own exit, so this record's local compression
        and write iterations only use ``record_check``. Plain calls keep the
        original full check on entry, iterations and exit.
        """
        self._ready()
        if type(raw) is not bytes:
            self._reject('raw record must be bytes')
        if len(raw) <= 1:
            self._reject('raw record must be nonempty')
        if len(raw) > self.maximum_record:
            self._reject('raw record exceeds the record bound')
        if raw[-1:] != b'\n' or raw.count(b'\n') != 1:
            self._reject('raw record must have exactly one final LF')
        if self._logical_bytes + len(raw) > self.maximum_logical:
            self._reject('logical raw wire byte bound exceeded')
        if bracketed:
            check = self._record_check
        else:
            check = self._check
        try:
            # A full live validation brackets this one publication. When the
            # caller owns that bracket, the pure-local feed/encode/write
            # iterations only pay its cheap refusal. A failure still closes
            # the writer, so no partial success can escape.
            check()
            for offset in range(0, len(raw), FEED):
                self._record_check()
                self._emit_encoded(
                    self._compressor.compress(raw[offset:offset + FEED]),
                    bracketed=True)
            self._logical.update(raw)
            self._logical_bytes += len(raw)
            self._records += 1
            check()
        except BaseException:
            self._fail('raw wire record write failed')
            raise

    def finish(self):
        """Write the gzip trailer, close the file, and return its identity."""
        self._ready()
        if self._records == 0 or self._logical_bytes == 0:
            self._reject('empty raw wire stream cannot be finished')
        try:
            self._check()
            self._emit_encoded(self._compressor.flush())
            self._compressor = None
            self._check()
            fd, self._fd = self._fd, None
            try:
                info = os.fstat(fd)
                if (not stat.S_ISREG(info.st_mode) or
                        info.st_size != self._encoded_bytes):
                    raise RawWireError('raw wire retained size changed')
                os.fsync(fd)
            finally:
                os.close(fd)
            self._closed = True
            result = {
                'model': MODEL,
                'encoded': {
                    'bytes': self._encoded_bytes,
                    'sha256': self._encoded.hexdigest(),
                },
                'logical': {
                    'bytes': self._logical_bytes,
                    'sha256': self._logical.hexdigest(),
                },
            }
            self._finished = True
            return result
        except BaseException:
            self._fail('raw wire finish failed')
            raise

    def abort(self):
        """Close a partial member without fabricating a gzip trailer."""
        if self._finished or self._closed:
            return
        self._aborted = True
        self._failure = self._failure or 'raw writer aborted'
        fd, self._fd = self._fd, None
        self._compressor = None
        self._closed = True
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        if exc_type is None:
            self.finish()
        else:
            self.abort()
        return False
