"""Stdlib unit tests for the kernel-raw-gzip-v1 writer and reader."""
import hashlib
import importlib.util
import os
from pathlib import Path
import shutil
import unittest
import zlib

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / '.test-data' / 'raw-codec-unit'
RUN = DATA / str(os.getpid())


def _load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


codec = _load('sdk_raw_wire_codec', 'qlever/scripts/sdk-raw-wire-codec.py')
reader = _load('sdk_raw_wire_reader', 'qlever/scripts/sdk-raw-wire-reader.py')
_MISSING = object()


def gzip_member(raw):
    compressor = zlib.compressobj(level=6, method=zlib.DEFLATED, wbits=31)
    return compressor.compress(raw) + compressor.flush()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def identity(encoded, logical):
    return dict(model=codec.MODEL,
                encoded=dict(bytes=len(encoded), sha256=sha(encoded)),
                logical=dict(bytes=len(logical), sha256=sha(logical)))


class RawWireCase(unittest.TestCase):
    def setUp(self):
        RUN.mkdir(parents=True, exist_ok=True)
        self.directory = RUN / self._testMethodName
        shutil.rmtree(self.directory, ignore_errors=True)
        self.directory.mkdir()

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def path(self):
        return self.directory / 'wire.ndjson.gz'

    def write(self, rows, maximum_logical=1 << 20, maximum_encoded=1 << 20,
              check=None):
        charged = []
        writer = codec.RawWriter(
            self.path(), claim=charged.append, check=check or (lambda: None),
            maximum_logical=maximum_logical, maximum_encoded=maximum_encoded)
        for row in rows:
            writer.write_record(row)
        return writer.finish(), charged

    def read(self, blocks, reference, maximum_logical=1 << 20,
             maximum_encoded=1 << 20, check=None, maximum_record=65536):
        return list(reader.iter_records(
            blocks, reference, check=check or (lambda: None),
            maximum_encoded=maximum_encoded,
            maximum_logical=maximum_logical,
            maximum_record=maximum_record))

    def disk_blocks(self, path):
        data = path.read_bytes()
        return [data[offset:offset + 65536]
                for offset in range(0, len(data), 65536)]


def pseudo_bytes(seed, size):
    output = bytearray()
    counter = 0
    while len(output) < size:
        output.extend(hashlib.sha256(
            seed + counter.to_bytes(8, 'big')).digest())
        counter += 1
    return bytes(output[:size])


class RoundTripTests(RawWireCase):
    def test_disk_roundtrip_across_compressed_boundaries(self):
        rows = [
            b'{"kind":"entry","sequence":1}\n',
            b'{"kind":"body","payload":"' + b'a' * 65400 + b'"}\n',
            b'{"kind":"body","payload":"' + (b'\\n' * 20000) + b'"}\n',
            b'{"kind":"exit","sequence":4}\n',
        ]
        reference, charged = self.write(rows)
        encoded = self.path().read_bytes()
        self.assertEqual(reference, identity(
            encoded, b''.join(rows)))
        self.assertEqual(sum(charged), len(encoded))
        self.assertEqual(encoded[:2], b'\x1f\x8b')
        self.assertEqual(self.path().stat().st_size, len(encoded))
        for limit in (1, 2, 3, 7, 65536):
            blocks = [encoded[offset:offset + limit]
                      for offset in range(0, len(encoded), limit)]
            self.assertEqual(self.read(blocks, reference), rows)
        self.assertEqual(self.read(self.disk_blocks(self.path()), reference),
                         rows)

    def test_records_pass_through_current_raw_decoder(self):
        spec = importlib.util.spec_from_file_location(
            'raw_records', ROOT / 'qlever/scripts/sdk-execution-originals-util.py')
        raw_records = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(raw_records)
        encoder = raw_records.IndexedRawEncoder()
        rows = [dict(kind='entry', sequence=1, nested={'text': '汉字'}),
                dict(kind='exit', sequence=2, nested={})]
        lines = [line for row in rows for line in encoder.encode(row)]
        reference, _ = self.write(lines)
        records = self.read(self.disk_blocks(self.path()), reference)
        self.assertEqual(records, lines)
        self.assertEqual(list(raw_records.decoded_raw_records(records)), rows)

    def test_streaming_output_chunks_are_bounded(self):
        writer = codec.RawWriter(
            self.path(), claim=lambda size: None, check=lambda: None,
            maximum_logical=1 << 20, maximum_encoded=1 << 20)
        rows = []
        for index in range(8):
            body = pseudo_bytes(b'sdk-raw-wire-' + bytes([index]), 30000)
            row = (b'{"index":' + str(index).encode() +
                   b',"body":"' + body.hex().encode() + b'"}\n')
            rows.append(row)
            writer.write_record(row)
        writer.abort()
        self.path().unlink()
        charged = []
        writer = codec.RawWriter(
            self.path(), claim=charged.append, check=lambda: None,
            maximum_logical=1 << 20, maximum_encoded=1 << 20)
        sizes = []
        for row in rows:
            writer.write_record(row)
            sizes.append(self.path().stat().st_size)
        reference = writer.finish()
        encoded = self.path().read_bytes()
        self.assertGreater(len(charged), 1)
        self.assertTrue(all(0 < size <= 65536 for size in charged))
        self.assertEqual(sum(charged), len(encoded))
        self.assertEqual(sizes, sorted(sizes))
        self.assertEqual(reference['encoded']['bytes'], len(encoded))
        for size in (1, 13, 65536):
            blocks = [encoded[offset:offset + size]
                      for offset in range(0, len(encoded), size)]
            self.assertEqual(self.read(blocks, reference), rows)

    def test_read_blocks_equal_to_gzip_producers_are_split(self):
        rows = [b'{"row":' + str(index).encode() + b'}\n'
                for index in range(3)]
        concatenated = b''.join(gzip_member(row) for row in rows)
        # A single-member reference must reject what looks like two members
        # even when the caller's source hands over a concatenated block.
        with self.assertRaises(reader.RawWireError):
            self.read([concatenated], identity(
                concatenated, b''.join(rows)))
        self.assertEqual(len(rows), 3)

    def test_encoded_bytes_are_one_gzip_member(self):
        rows = [b'{"row":1}\n']
        reference, _ = self.write(rows)
        encoded = self.path().read_bytes()
        inflater = zlib.decompressobj(31)
        self.assertEqual(inflater.decompress(encoded), b''.join(rows))
        self.assertTrue(inflater.eof)
        self.assertEqual(inflater.unused_data, b'')
        self.assertEqual(zlib.decompress(encoded, 31), b''.join(rows))

    def test_empty_stream_is_rejected(self):
        with self.assertRaises(codec.RawWireError):
            self.write([])
        empty = gzip_member(b'')
        with self.assertRaises(reader.RawWireError):
            self.read([empty], identity(empty, b''))
        with self.assertRaises(reader.RawWireError):
            self.read([], identity(b'', b''))
        with self.assertRaises(reader.RawWireError):
            self.read([b''], identity(b'', b''))


class WriterRejectionTests(RawWireCase):
    def test_record_wire_shape(self):
        for row in (b'', b'\n', b'{"a":1}', b'{"a":1}\n\n',
                    b'{"a":"x\ny"}\n'):
            with self.subTest(row=row):
                with self.assertRaises(codec.RawWireError):
                    self.write([row])
                if self.path().exists():
                    self.path().unlink()
        # The writer never reinterprets JSON: a non-JSON single-LF row is
        # still an exact wire row and must roundtrip byte for byte.
        reference, _ = self.write(['not json\n'.encode()])
        self.assertEqual(
            self.read(self.disk_blocks(self.path()), reference),
            ['not json\n'.encode()])

    def test_record_size_bound(self):
        edge = b'{"x":"' + b'a' * (65536 - 9) + b'"}\n'
        self.assertEqual(len(edge), 65536)
        reference, _ = self.write([edge])
        self.assertEqual(reference['logical']['bytes'], 65536)
        self.assertEqual(
            self.read(self.disk_blocks(self.path()), reference), [edge])
        self.path().unlink()
        with self.assertRaises(codec.RawWireError):
            self.write([b'{"x":"' + b'a' * (65536 - 7) + b'"}\n'])
        self.path().unlink()
        reference, _ = self.write([b'{"x":"' + b'a' * 100 + b'"}\n'])
        self.assertEqual(reference['logical']['bytes'], 109)

    def test_tiny_maxima_are_preserved(self):
        row = b'{"a":1}\n'
        with self.assertRaises(codec.RawWireError):
            self.write([row], maximum_logical=len(row) - 1)
        self.path().unlink()
        reference, _ = self.write([row], maximum_logical=len(row))
        self.assertEqual(reference['logical']['bytes'], len(row))
        encoded = reference['encoded']['bytes']
        self.path().unlink()
        with self.assertRaises(codec.RawWireError):
            self.write([row], maximum_encoded=encoded - 1)
        self.path().unlink()
        reference, _ = self.write([row], maximum_encoded=encoded)
        self.assertEqual(reference['encoded']['bytes'], encoded)

    def test_write_buffers_and_claim_before_write(self):
        rows = [b'{"a":1}\n', b'{"b":2}\n']
        charged = []
        path = self.path()
        written = []
        real_write = os.write

        def observed_write(fd, data):
            written.append(len(data))
            return real_write(fd, data)

        writer = codec.RawWriter(
            path, claim=charged.append, check=lambda: None,
            maximum_logical=100, maximum_encoded=100)
        original = codec.os.write
        codec.os.write = observed_write
        try:
            for row in rows:
                writer.write_record(row)
            reference = writer.finish()
        finally:
            codec.os.write = original
        self.assertEqual(sum(charged), len(path.read_bytes()))
        self.assertTrue(written)
        self.assertTrue(all(0 < size <= 65536 for size in written))
        self.assertEqual(sum(written), len(path.read_bytes()))
        self.assertEqual(reference['encoded']['bytes'],
                         len(path.read_bytes()))

    def test_check_cancellation_fails_and_closes(self):
        calls = []

        def check():
            calls.append(len(calls))
            if len(calls) > 2:
                raise RuntimeError('cancelled')

        writer = codec.RawWriter(
            self.path(), claim=lambda count: None, check=check,
            maximum_logical=100, maximum_encoded=100)
        with self.assertRaises(RuntimeError):
            writer.write_record(b'{"a":1}\n')
        with self.assertRaises(codec.RawWireError):
            writer.write_record(b'{"b":2}\n')
        with self.assertRaises(codec.RawWireError):
            writer.finish()
        writer.abort()
        self.assertTrue(self.path().is_file())

    def test_partial_write_failure_is_conservative(self):
        path = self.path()
        charged = []
        real_write = os.write

        def failing_write(fd, data):
            real_write(fd, bytes(data)[:3])
            raise OSError('disk full')

        writer = codec.RawWriter(
            path, claim=charged.append, check=lambda: None,
            maximum_logical=100, maximum_encoded=100)
        original = codec.os.write
        codec.os.write = failing_write
        try:
            with self.assertRaises(OSError):
                writer.write_record(b'{"a":1}\n')
        finally:
            codec.os.write = original
        retained = path.stat().st_size
        self.assertEqual(retained, 3)
        self.assertGreaterEqual(sum(charged), retained)
        with self.assertRaises(codec.RawWireError):
            writer.finish()

    def test_claim_failure_is_conservative(self):
        path = self.path()
        charged = []

        def claim(count):
            charged.append(count)
            raise AssertionError('source ledger exhausted')

        writer = codec.RawWriter(
            path, claim=claim, check=lambda: None,
            maximum_logical=100, maximum_encoded=100)
        with self.assertRaises(AssertionError):
            writer.write_record(b'{"a":1}\n')
        # The claim ran before any retained byte, and the failure is sticky.
        self.assertEqual(path.stat().st_size, 0)
        self.assertEqual(len(charged), 1)
        with self.assertRaises(codec.RawWireError):
            writer.write_record(b'{"b":2}\n')
        writer.abort()
        self.assertEqual(path.stat().st_size, 0)

    def test_short_write_fully_loops_or_fails_conservative(self):
        path = self.path()
        charged = []
        real_write = os.write
        calls = []

        def short_write(fd, data):
            calls.append(len(data))
            return real_write(fd, bytes(data)[:3])

        writer = codec.RawWriter(
            path, claim=charged.append, check=lambda: None,
            maximum_logical=100, maximum_encoded=100)
        original = codec.os.write
        codec.os.write = short_write
        try:
            writer.write_record(b'{"a":1}\n')
            reference = writer.finish()
        finally:
            codec.os.write = original
        self.assertEqual(len(path.read_bytes()), reference['encoded']['bytes'])
        self.assertEqual(sum(charged), reference['encoded']['bytes'])
        self.assertTrue(all(size <= 65536 for size in calls))
        self.assertEqual(self.read(self.disk_blocks(path), reference),
                         [b'{"a":1}\n'])

    def test_failure_is_permanent_and_preserves_partial_file(self):
        path = self.path()
        writer = codec.RawWriter(
            path, claim=lambda count: None, check=lambda: None,
            maximum_logical=1000, maximum_encoded=1000)
        writer.write_record(b'{"a":1}\n')
        before = path.read_bytes()
        writer.abort()
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse(path.read_bytes().endswith(b'\x00\x00\x00\x00'))
        for call in (lambda: writer.write_record(b'{"b":2}\n'),
                     writer.finish):
            with self.assertRaises(codec.RawWireError):
                call()
        with self.assertRaises(reader.RawWireError):
            self.read([before], identity(before, b'{"a":1}\n'))
        # A fresh writer cannot reuse the preserved diagnostic path.
        with self.assertRaises(FileExistsError):
            self.write([b'{"a":1}\n'])

    def test_new_exclusive_regular_file(self):
        path = self.path()
        path.write_bytes(b'existing')
        with self.assertRaises(FileExistsError):
            codec.RawWriter(
                path, claim=lambda count: None, check=lambda: None,
                maximum_logical=10, maximum_encoded=10)
        self.assertEqual(path.read_bytes(), b'existing')
        directory = self.directory / 'directory'
        directory.mkdir()
        with self.assertRaises((IsADirectoryError, OSError)):
            codec.RawWriter(
                directory, claim=lambda count: None, check=lambda: None,
                maximum_logical=10, maximum_encoded=10)
        symlink = self.directory / 'link'
        symlink.symlink_to(path)
        with self.assertRaises(OSError):
            codec.RawWriter(
                symlink, claim=lambda count: None, check=lambda: None,
                maximum_logical=10, maximum_encoded=10)


class ReaderRejectionTests(RawWireCase):
    def setUp(self):
        super().setUp()
        self.rows = [b'{"a":1}\n', b'{"b":"' + b'x' * 5000 + b'"}\n']
        self.reference, _ = self.write(self.rows)
        self.encoded = self.path().read_bytes()

    def assertRejected(self, blocks, reference=_MISSING, **options):
        with self.assertRaises(reader.RawWireError):
            self.read(blocks, self.reference if reference is _MISSING
                      else reference, **options)

    def test_crc_and_trailer_mutation(self):
        for offset in (-8, -7, -6, -5, -4, -3, -2, -1):
            damaged = bytearray(self.encoded)
            damaged[offset] ^= 0x01
            with self.subTest(offset=offset):
                self.assertRejected([bytes(damaged)])
        header = bytearray(self.encoded)
        header[0] = 0
        self.assertRejected([bytes(header)])

    def test_truncated_stream(self):
        for size in (0, 1, 2, 9, 10, 11, len(self.encoded) - 1):
            with self.subTest(size=size):
                self.assertRejected([self.encoded[:size]])
        inflater = zlib.decompressobj(31)
        logical = inflater.decompress(self.encoded)
        self.assertEqual(logical, b''.join(self.rows))

    def test_extra_data_and_second_member(self):
        self.assertRejected([self.encoded + b'extra'])
        self.assertRejected([self.encoded + gzip_member(b'{"c":3}\n')])
        self.assertRejected([self.encoded, b'extra'])
        forged = identity(self.encoded + b'extra',
                          b''.join(self.rows))
        self.assertRejected([self.encoded + b'extra'], forged)
        empty_second = identity(self.encoded + gzip_member(b''),
                                b''.join(self.rows))
        self.assertRejected([self.encoded + gzip_member(b'')], empty_second)

    def test_changed_hashes_and_counts(self):
        for name, key, value in (
                ('encoded', 'bytes', self.reference['encoded']['bytes'] + 1),
                ('encoded', 'bytes', self.reference['encoded']['bytes'] - 1),
                ('logical', 'bytes', self.reference['logical']['bytes'] - 1),
                ('logical', 'bytes', self.reference['logical']['bytes'] + 1)):
            changed = dict(self.reference)
            changed[name] = dict(self.reference[name], **{key: value})
            with self.subTest(name=name, value=value):
                self.assertRejected([self.encoded], changed)
        for name in ('encoded', 'logical'):
            changed = dict(self.reference)
            changed[name] = dict(self.reference[name], sha256='0' * 64)
            with self.subTest(name=name):
                self.assertRejected([self.encoded], changed)
        self.assertEqual(self.read([self.encoded], self.reference),
                         self.rows)

    def test_reference_shape_is_not_boolean_authority(self):
        for reference in (
                None, dict(self.reference, model='kernel-raw-gzip-v0'),
                {'model': codec.MODEL, 'encoded': self.reference['encoded']},
                dict(self.reference, extra=True),
                dict(self.reference, logical={'bytes': True,
                                              'sha256': '0' * 64}),
                dict(self.reference,
                     encoded=dict(self.reference['encoded'], sha256='A' * 64))):
            with self.subTest(reference=reference):
                self.assertRejected([self.encoded], reference)

    def test_oversized_record_and_missing_lf(self):
        big = b'{"x":"' + b'a' * 70000 + b'"}\n'
        encoded = gzip_member(big)
        self.assertRejected([encoded], identity(encoded, big),
                            maximum_logical=1 << 20)
        with self.assertRaises(reader.RawWireError):
            list(reader.iter_records(
                [encoded], identity(encoded, big), check=lambda: None,
                maximum_encoded=1 << 20, maximum_logical=1 << 20,
                maximum_record=65535))
        missing = b''.join(self.rows)[:-1]
        encoded = gzip_member(missing)
        self.assertRejected([encoded], identity(encoded, missing))

    def test_over_limit_output_including_compression_bombs(self):
        compressor = zlib.compressobj(level=9, method=zlib.DEFLATED, wbits=31)
        bomb = compressor.compress((b'x\n' * 200000)) + compressor.flush()
        self.assertLess(len(bomb), 10000)
        self.assertRejected([bomb], identity(bomb, b'x\n' * 200000),
                            maximum_logical=1 << 18)
        exact = b'{"a":1}\n'
        encoded = gzip_member(exact)
        self.assertRejected([encoded], identity(encoded, exact),
                            maximum_logical=len(exact) - 1)
        self.assertRejected([encoded], identity(encoded, exact),
                            maximum_encoded=len(encoded) - 1)
        self.assertRejected([b'x' * 65537])

    def test_blocks_are_bounded_bytes(self):
        self.assertRejected([None])
        self.assertRejected([bytearray(self.encoded)])
        self.assertRejected([b'x' * 65537])
        self.assertRejected([self.encoded], maximum_record=0)

    def test_check_every_input_chunk(self):
        calls = []

        def check():
            calls.append(1)
            if len(calls) > 2:
                raise RuntimeError('cancelled')

        with self.assertRaises(RuntimeError):
            self.read([self.encoded], self.reference, check=check)
        calls.clear()
        with self.assertRaises(RuntimeError):
            self.read([self.encoded[:1], self.encoded[1:]],
                      self.reference, check=check)

    def test_verification_happens_on_exhaustion_not_creation(self):
        stream = reader.iter_records(
            self.disk_blocks(self.path()), self.reference,
            check=lambda: None, maximum_encoded=1 << 20,
            maximum_logical=1 << 20)
        self.assertEqual(next(stream), self.rows[0])
        self.assertEqual(list(stream), self.rows[1:])


def tearDownModule():
    shutil.rmtree(RUN, ignore_errors=True)
    try:
        DATA.rmdir()
    except OSError:
        pass


if __name__ == '__main__':
    RUN.mkdir(parents=True, exist_ok=True)
    unittest.main()
