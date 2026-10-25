"""Stdlib unit tests for the lossless schema-indexed raw v2 wire format."""
import hashlib
import importlib.util
import json
import os
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MODULE = os.path.join(ROOT, 'qlever', 'scripts', 'sdk-execution-originals-util.py')


def _load():
    spec = importlib.util.spec_from_file_location('sdk_indexed_raw_v2', MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


raw = _load()


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def encode(rows, encoder=None):
    encoder = encoder or raw.IndexedRawEncoderV2()
    return encoder, [line for row in rows for line in encoder.encode(row)]


def decode(lines):
    decoder = raw.RawRecordDecoder()
    rows = []
    for line in lines:
        row = decoder.feed(line)
        if row is not None:
            rows.append(row)
    decoder.finish()
    return decoder, rows


def record(sequence=1, **values):
    row = dict(kind='entry', phase='exec', arch='arm64', sequence=sequence,
               observedUnixNs=1700000000000000000 + sequence,
               observedMonotonicNs=100 + sequence)
    row.update(values)
    return row


class RoundTripTests(unittest.TestCase):
    def test_deep_equality_and_canonical_digest(self):
        rows = [
            record(1, pid=10, meta={'argv': ['run', '--x'], 'text': '汉字'}),
            record(2, pid=11, meta={}),
            record(3, pid=12, meta=None),
        ]
        encoder, lines = encode(rows)
        self.assertEqual(encoder.metadata_bytes, sum(
            len(line) for line in lines if b'"schema"' in line))
        decoder, decoded = decode(lines)
        self.assertEqual(decoded, rows)
        self.assertEqual(decoder.model, raw.RAW_RECORD_MODEL_V2)
        self.assertEqual([digest(row) for row in decoded],
                         [digest(row) for row in rows])

    def test_exact_large_integers_survive_json(self):
        huge = 2 ** 200
        rows = [record(1, observedUnixNs=huge, observedMonotonicNs=-huge),
                record(2, observedUnixNs=huge + 1,
                       observedMonotonicNs=-huge - 1)]
        _, lines = encode(rows)
        _, decoded = decode(lines)
        self.assertEqual(decoded, rows)
        self.assertIs(type(decoded[0]['observedUnixNs']), int)

    def test_negative_and_out_of_order_deltas(self):
        sequence = [5, 2, 9, -3, 0, -7]
        rows = [record(value, observedUnixNs=10 ** 18 - value,
                       observedMonotonicNs=-value) for value in sequence]
        _, lines = encode(rows)
        first = json.loads(lines[2])
        self.assertTrue(all(type(item) is int for item in first[2]))
        fields = json.loads(lines[1])[2]['fields']
        constants = json.loads(lines[1])[2]['constants']
        payload_names = [name for name in fields if name not in constants]
        position = payload_names.index('sequence')
        deltas = [json.loads(line)[2][position] for line in lines[2:]]
        self.assertTrue(any(value < 0 for value in deltas))
        _, decoded = decode(lines)
        self.assertEqual(decoded, rows)

    def test_constants_removed_from_every_row_payload(self):
        rows = [record(index) for index in range(1, 6)]
        _, lines = encode(rows)
        schema = json.loads(lines[1])
        self.assertEqual(schema[2]['constants'],
                         {'kind': 'entry', 'phase': 'exec', 'arch': 'arm64'})
        payload_names = [name for name in schema[2]['fields']
                         if name not in schema[2]['constants']]
        absolute = json.loads(lines[2])[2]
        self.assertEqual(dict(zip(payload_names, absolute)),
                         dict(observedMonotonicNs=101,
                              observedUnixNs=1700000000000000001,
                              sequence=1))
        for line in lines[3:]:
            payload = json.loads(line)[2]
            self.assertEqual(len(payload), 3)
            self.assertEqual(dict(zip(payload_names, payload)),
                             dict(observedMonotonicNs=1,
                                  observedUnixNs=1, sequence=1))
        self.assertLess(sum(map(len, lines[2:])), sum(
            len(canonical(row)) for row in rows))
        _, decoded = decode(lines)
        self.assertEqual(decoded, rows)

    def test_mixed_schemas_and_constant_changes(self):
        rows = [record(1), record(2, kind='exit'), record(3),
                record(4, arch='x86_64', pid=1)]
        encoder, lines = encode(rows)
        self.assertGreaterEqual(len(encoder.schemas), 3)
        _, decoded = decode(lines)
        self.assertEqual(decoded, rows)

    def test_integer_constants_are_allowed(self):
        rows = [dict(kind='entry', phase=7, arch=8, sequence=1,
                     observedUnixNs=5, observedMonotonicNs=6, code=7),
                dict(kind='entry', phase=7, arch=8, sequence=2,
                     observedUnixNs=6, observedMonotonicNs=7, code=7)]
        _, lines = encode(rows)
        schema = json.loads(lines[1])
        self.assertEqual(schema[2]['constants']['phase'], 7)
        self.assertEqual(schema[2]['constants']['arch'], 8)
        self.assertNotIn('code', schema[2]['constants'])
        self.assertEqual(decode(lines)[1], rows)

    def test_one_schema_wire_bundle_is_bounded(self):
        encoder = raw.IndexedRawEncoderV2()
        lines = encoder.encode(record(1))
        self.assertLessEqual(sum(map(len, lines)), raw.RAW_RECORD_LIMIT)
        self.assertLessEqual(sum(map(len, lines[1:])), raw.RAW_RECORD_LIMIT)


class LegacyTests(unittest.TestCase):
    def test_v1_encoding_and_decoding_unchanged(self):
        rows = [dict(kind='entry', sequence=1, nested={'text': '汉字'}),
                dict(kind='exit', sequence=2, nested={})]
        encoder = raw.IndexedRawEncoder()
        lines = [line for row in rows for line in encoder.encode(row)]
        decoder, decoded = decode(lines)
        self.assertEqual(decoded, rows)
        self.assertIs(decoder.schemas[0], decoder.schemas[0])
        self.assertEqual(decoder.schemas[0], ('kind', 'nested', 'sequence'))
        self.assertEqual(type(decoder.schemas[0]), tuple)
        self.assertEqual(decoder.model, raw.RAW_RECORD_MODEL)

    def test_legacy_plan_records_still_decode(self):
        rows = [{'x': [1, 2]}, {'x': None, 'y': 'z'}]
        lines = []
        for row in rows:
            lines.append(canonical(row))
        self.assertEqual(decode(lines)[1], rows)

    def test_v1_default_encoder_is_not_v2(self):
        self.assertNotEqual(raw.RAW_RECORD_MODEL, raw.RAW_RECORD_MODEL_V2)
        lines = raw.IndexedRawEncoder().encode(record(1))
        self.assertEqual(json.loads(lines[0]), [raw.RAW_RECORD_MODEL])
        self.assertNotIn(b'-v2', b''.join(lines))


class MalformedSchemaTests(unittest.TestCase):
    def schema_stream(self, definition, row=record(1)):
        encoder = raw.IndexedRawEncoderV2()
        lines = encoder.encode(row)
        header, _, data = lines
        forged = canonical(['schema', 0, definition])
        return [header, forged, data]

    def assert_rejected(self, lines):
        with self.assertRaises(AssertionError):
            decode(lines)

    def test_unknown_sections_and_fields(self):
        base = {'fields': ['arch', 'kind', 'observedMonotonicNs',
                           'observedUnixNs', 'phase', 'sequence'],
                'constants': {'kind': 'entry', 'phase': 'exec',
                              'arch': 'arm64'},
                'deltas': {'sequence': 'sequence',
                           'observedUnixNs': 'observedUnixNs',
                           'observedMonotonicNs': 'observedMonotonicNs'}}
        variants = []
        for key in ('unknown', 'extra'):
            broken = json.loads(json.dumps(base))
            broken[key] = {}
            variants.append(broken)
        for name in ('unknownKind', 'sequence_', 'KIND'):
            broken = json.loads(json.dumps(base))
            broken['constants'][name] = 'x'
            variants.append(broken)
        for name in ('unknownDelta', 'tick'):
            broken = json.loads(json.dumps(base))
            broken['deltas'][name] = name
            variants.append(broken)
        for definition in variants:
            with self.subTest(definition=definition):
                self.assert_rejected(self.schema_stream(definition))

    def test_invalid_types_and_bounds(self):
        fields = ['arch', 'kind', 'phase', 'sequence']
        variants = [
            {'fields': fields, 'constants': {'kind': True}},
            {'fields': fields, 'constants': {'kind': None}},
            {'fields': fields, 'constants': {'kind': ['entry']}},
            {'fields': fields, 'constants': {'kind': 1.5}},
            {'fields': fields, 'deltas': {'sequence': 1}},
            {'fields': fields, 'deltas': {'sequence': True}},
            {'fields': fields, 'deltas': {'kind': 'kind'}},
            {'fields': fields, 'constants': {'kind': 'entry'},
             'deltas': {'sequence': 'sequence'}, 'extra': 1},
            {'fields': []},
            {'fields': list(reversed(fields))},
            {'fields': ['a'] * 2},
            {'fields': ['a'], 'constants': {'a': 'x'}},
        ]
        for definition in variants:
            with self.subTest(definition=definition):
                self.assert_rejected(self.schema_stream(definition))

    def test_duplicate_and_undeclared_declarations(self):
        fields = ['arch', 'kind', 'phase', 'sequence']
        variants = [
            {'fields': fields, 'constants': {'kind': 'a', 'phase': 'b'},
             'deltas': {'sequence': 'sequence'}},
            {'fields': fields + ['pid'], 'constants': {'kind': 'a'},
             'deltas': {'pid': 'pid'}},
        ]
        for definition in variants:
            with self.subTest(definition=definition):
                self.assert_rejected(self.schema_stream(definition))

    def test_schema_index_and_ordering(self):
        header, schema, data = self.schema_stream({
            'fields': ['arch', 'kind', 'phase', 'sequence'],
            'constants': {'arch': 'arm64', 'kind': 'entry', 'phase': 'exec'},
            'deltas': {'sequence': 'sequence'}})
        self.assert_rejected([header, canonical(['schema', 1, json.loads(schema)[2]]), data])
        self.assert_rejected([header, schema, schema, data])
        second = json.loads(schema)[2]
        self.assert_rejected([header, schema, canonical(['schema', 1, second]), data])

    def test_row_schema_and_value_shape(self):
        fields = ['arch', 'kind', 'phase', 'sequence']
        definition = {'fields': fields,
                      'constants': {'arch': 'arm64', 'kind': 'entry',
                                    'phase': 'exec'},
                      'deltas': {'sequence': 'sequence'}}
        header = canonical([raw.RAW_RECORD_MODEL_V2])
        schema = canonical(['schema', 0, definition])
        for row in (['row', 0, []], ['row', 1, [1]],
                    ['row', 0, [1, 2]], ['row', 0, [True]],
                    ['row', 0, ['1']], ['row', 0, [1.0]],
                    ['row', 0, 1], ['row', 0, [None]]):
            with self.subTest(row=row):
                self.assert_rejected([header, schema, canonical(row)])

    def test_new_schema_must_be_used_immediately(self):
        header = canonical([raw.RAW_RECORD_MODEL_V2])
        first = canonical(['schema', 0, {
            'fields': ['sequence'], 'deltas': {'sequence': 'sequence'}}])
        second = canonical(['schema', 1, {
            'fields': ['sequence'], 'deltas': {'sequence': 'sequence'}}])
        self.assert_rejected([header, first, second, canonical(['row', 0, [1]])])


class MalformedDeltaTests(unittest.TestCase):
    def lines(self):
        rows = [record(10), record(20)]
        return encode(rows)[1]

    def test_non_integer_deltas_are_rejected(self):
        header, schema, first, second = self.lines()
        for payload in (['1'], [True], [1.5], [None], [{'x': 1}]):
            with self.subTest(payload=payload):
                with self.assertRaises(AssertionError):
                    decode([header, schema, first,
                            canonical(['row', 0, payload])])

    def test_truncated_and_overlong_rows(self):
        header, schema, first, second = self.lines()
        payload = json.loads(second)[2]
        for broken in (payload[:-1], payload + [0]):
            with self.subTest(broken=broken):
                with self.assertRaises(AssertionError):
                    decode([header, schema, first,
                            canonical(['row', 0, broken])])

    def test_tampered_schema_index(self):
        header, schema, first, second = self.lines()
        with self.assertRaises(AssertionError):
            decode([header, schema, first,
                    canonical(['row', 7, json.loads(second)[2]])])

    def test_non_integer_constant_in_row_is_rejected(self):
        # Constants never appear in the payload, so a forged payload shifts
        # every remaining field; exact decoding must reject it.
        header, schema, first, second = self.lines()
        with self.assertRaises(AssertionError):
            decode([header, schema, first,
                    canonical(['row', 0, ['extra'] + json.loads(second)[2]])])


class TypedStringDeltaTests(unittest.TestCase):
    def string_record(self, sequence=1, **values):
        row = record(sequence, observedUnixNs=str(1700000000000000000 + sequence),
                     observedMonotonicNs=str(100 + sequence))
        row.update(values)
        return row

    def delta_types(self, lines):
        return json.loads(lines[1])[2]['deltas']

    def test_string_timestamps_round_trip_with_typed_schema(self):
        rows = [self.string_record(1, pid=10),
                self.string_record(2, pid=11),
                self.string_record(3, pid=12)]
        encoder, lines = encode(rows)
        self.assertEqual(self.delta_types(lines), {
            'sequence': 'int', 'observedUnixNs': 'str',
            'observedMonotonicNs': 'str'})
        schema = json.loads(lines[1])[2]
        self.assertEqual(schema['fields'], sorted(schema['fields']))
        payload_names = [name for name in schema['fields']
                         if name not in schema['constants']]
        position = payload_names.index('observedUnixNs')
        first = json.loads(lines[2])[2][position]
        second = json.loads(lines[3])[2][position]
        self.assertIs(type(first), int)
        self.assertEqual(first, 1700000000000000001)
        self.assertEqual(second, 1)
        decoder, decoded = decode(lines)
        self.assertEqual(decoded, rows)
        self.assertIs(type(decoded[0]['observedUnixNs']), str)
        self.assertIs(type(decoded[0]['sequence']), int)
        self.assertEqual([canonical(row) for row in decoded],
                         [canonical(row) for row in rows])
        self.assertEqual([digest(row) for row in decoded],
                         [digest(row) for row in rows])
        self.assertEqual(encoder.metadata_bytes, sum(
            len(line) for line in lines if b'"schema"' in line))

    def test_huge_negative_and_out_of_order_string_values(self):
        huge = 2 ** 220
        values = [huge, -huge, huge - 1, -huge + 1, 0, -1]
        rows = [record(index + 1,
                       observedUnixNs=str(value),
                       observedMonotonicNs=str(-value))
                for index, value in enumerate(values)]
        _, lines = encode(rows)
        _, decoded = decode(lines)
        self.assertEqual(decoded, rows)
        self.assertEqual(decoded[0]['observedUnixNs'], str(huge))
        self.assertEqual(decoded[1]['observedMonotonicNs'], str(huge))
        self.assertEqual([digest(row) for row in decoded],
                         [digest(row) for row in rows])

    def test_noncanonical_strings_pass_through_verbatim(self):
        values = ['0' * 3, '+7', '-0', ' 8', '9 ', '1e3', '0x10', '1_000',
                  '\u0661', '']
        rows = [record(index + 1, observedUnixNs=value,
                       observedMonotonicNs=str(index))
                for index, value in enumerate(values)]
        _, lines = encode(rows)
        schema = json.loads(lines[1])[2]
        self.assertNotIn('observedUnixNs', schema['deltas'])
        payload_names = [name for name in schema['fields']
                         if name not in schema['constants']]
        position = payload_names.index('observedUnixNs')
        self.assertEqual([json.loads(line)[2][position] for line in lines[2:]],
                         values)
        _, decoded = decode(lines)
        self.assertEqual([row['observedUnixNs'] for row in decoded], values)
        self.assertEqual(decoded, rows)

    def test_int_and_string_deltas_never_share_a_schema(self):
        rows = [record(1, observedUnixNs=1, observedMonotonicNs=2),
                record(2, observedUnixNs='1', observedMonotonicNs='2'),
                record(3, observedUnixNs=1, observedMonotonicNs=2)]
        encoder, lines = encode(rows)
        self.assertEqual(len(encoder.schemas), 2)
        schemas = [json.loads(line)[2] for line in lines if b'"schema"' in line]
        self.assertEqual([schema['deltas']['observedUnixNs'] for schema in schemas],
                         ['int', 'str'])
        _, decoded = decode(lines)
        self.assertEqual(decoded, rows)
        self.assertIs(type(decoded[0]['observedUnixNs']), int)
        self.assertIs(type(decoded[1]['observedUnixNs']), str)

    def test_malformed_delta_declarations_are_rejected(self):
        fields = ['arch', 'kind', 'observedMonotonicNs', 'observedUnixNs',
                  'phase', 'sequence']
        for kind in ('bool', 'float', 'float64', 'int64', True, 1, None,
                     ['int'], {'type': 'str'}, 'str '):
            definition = {'fields': fields,
                          'deltas': {'observedUnixNs': kind}}
            with self.subTest(kind=kind):
                with self.assertRaises(AssertionError):
                    decode([canonical([raw.RAW_RECORD_MODEL_V2]),
                            canonical(['schema', 0, definition]),
                            canonical(['row', 0, ['entry', 'exec', 'arm64',
                                                  '1', '2', 1]])])

    def test_malformed_string_delta_payloads_are_rejected(self):
        rows = [self.string_record(1), self.string_record(2)]
        header, schema, first, second = encode(rows)[1]
        definition = json.loads(schema)[2]
        payload_names = [name for name in definition['fields']
                         if name not in definition.get('constants', {})]
        position = payload_names.index('observedUnixNs')
        base = json.loads(second)[2]
        for value in ('1', True, False, 1.5, None, [1], {'x': 1}):
            broken = list(base)
            broken[position] = value
            with self.subTest(value=value):
                with self.assertRaises(AssertionError):
                    decode([header, schema, first,
                            canonical(['row', 0, broken])])

    def test_string_delta_wire_bundle_stays_bounded(self):
        rows = [self.string_record(index) for index in range(1, 40)]
        _, lines = encode(rows)
        self.assertLessEqual(sum(map(len, lines)), raw.RAW_RECORD_LIMIT)
        self.assertLessEqual(sum(map(len, lines[1:])), raw.RAW_RECORD_LIMIT)
        self.assertEqual(decode(lines)[1], rows)


if __name__ == '__main__':
    unittest.main()
