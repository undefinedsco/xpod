"""Transport codec tests: lossless round trip plus every structural refusal.

These are UNIT tests of the transport only. They assert nothing about real SDK,
compiler, ABI or release qualification, and the transport itself grants no
authority.

SELF-CONTAINED: this file resolves the repository root from its own location
(`qlever/tests/` -> repository root) and loads the production codec from
`qlever/scripts/`. It reads no ignored `.test-data`, needs no preparation, and
runs in a clean public checkout:

    python3 -m unittest qlever.tests.test_sdk_generated_producer_transport -v
    # or directly:
    python3 qlever/tests/test_sdk_generated_producer_transport.py
"""
import copy
import importlib.util
import json
import sys
import unittest
from pathlib import Path

# qlever/tests/<this file> -> parents[2] is the repository root.
ROOT = Path(__file__).resolve().parents[2]
CODEC = ROOT / 'qlever' / 'scripts' / 'sdk-generated-producer-transport.py'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


codec = load('transport_codec', CODEC)

GENERATION = {'identity': ['1', '7', '33188', '16', '11', '12'], 'flags': 0, 'position': 0}
A = ['1', '7', '33188', '16', '11', '12']
B = ['1', '8', '33188', '16', '11', '12']
EXEC = ['1', '5', '33261', '8', '1', '1']
OUT0 = ['1', '9000', '33152', '64', '21', '22']
OUT1 = ['1', '9001', '33152', '32', '21', '22']


def sample():
    """A compact but contract-complete sample: two shared sources, four reads
    (scalar pread, iovec preadv, a second byte version of one identity, and a
    mapping input) feeding two outputs."""
    inputs = [
        dict(inputId=0, entrySequence=100, captureSequence=102, identity=list(A),
             bytes=16, sha256='a' * 64, protection=1, flags=0, lifetimeLeaseSequence=5,
             executable=False, inputModel='regular-read', resolvedPath='/usr/include/a.h',
             regularRead=dict(form='pread64', fd=3, readLeaseSequence=5, rangeStart=0,
                              consumedLength=16, result=16, exitSequence=103,
                              generation=GENERATION, iovcnt=None, iovLengths=None),
             graphKey=('read', 102)),
        dict(inputId=1, entrySequence=200, captureSequence=202, identity=list(B),
             bytes=16, sha256='b' * 64, protection=1, flags=0, lifetimeLeaseSequence=5,
             executable=False, inputModel='regular-read', resolvedPath='/usr/include/b.h',
             regularRead=dict(form='preadv', fd=4, readLeaseSequence=5, rangeStart=8,
                              consumedLength=16, result=16, exitSequence=203,
                              generation=GENERATION, iovcnt=2, iovLengths=[8, 8]),
             graphKey=('read', 202)),
        # SECOND byte version of identity A
        dict(inputId=2, entrySequence=300, captureSequence=302, identity=list(A),
             bytes=24, sha256='c' * 64, protection=1, flags=0, lifetimeLeaseSequence=5,
             executable=False, inputModel='regular-read', resolvedPath='/usr/include/a.h',
             regularRead=dict(form='pread64', fd=3, readLeaseSequence=5, rangeStart=0,
                              consumedLength=24, result=24, exitSequence=303,
                              generation=GENERATION, iovcnt=None, iovLengths=None),
             graphKey=('read', 302)),
        # mapping input: no regularRead, and deliberately no resolvedPath key
        dict(inputId=3, entrySequence=400, captureSequence=402, identity=list(B),
             bytes=32, sha256='d' * 64, protection=1, flags=0, lifetimeLeaseSequence=5,
             executable=True, inputModel='mapping', graphKey=('mapping', 402)),
    ]
    inputs[0]['futureProofField'] = {'nested': [1, 2, 3]}

    witness = [
        dict(path='/build/out0.o', bytes=64, sha256='e' * 64, identity=list(OUT0),
             completedCloseSequence=500, producerCaptureSequence=498, producerPid=11,
             phase='compile', inputComplete=True, readOperations=3, inputObligationCount=3,
             unexplainedReads=[], mappingInputCount=1, readInputCount=2, inputIds=[0, 1, 3],
             execImage=dict(pid=11, phase='compile', exe='/usr/bin/cc', identity=list(EXEC),
                            bytes=8, sha256='f' * 64),
             futureWitnessField='preserved'),
        dict(path='/build/out1.o', bytes=32, sha256='0' * 64, identity=list(OUT1),
             completedCloseSequence=700, producerCaptureSequence=698, producerPid=12,
             phase='compile', inputComplete=True, readOperations=1, inputObligationCount=1,
             unexplainedReads=[], mappingInputCount=0, readInputCount=1, inputIds=[2],
             execImage=dict(pid=12, phase='compile', exe='/usr/bin/cc', identity=list(EXEC),
                            bytes=8, sha256='f' * 64)),
    ]

    nodes = [
        dict(nodeId=0, model='regular-read', identity=list(A), bytes=16, sha256='a' * 64),
        dict(nodeId=1, model='regular-read', identity=list(B), bytes=16, sha256='b' * 64),
        dict(nodeId=2, model='regular-read', identity=list(A), bytes=24, sha256='c' * 64),
        dict(nodeId=3, model='mapping', identity=list(B), bytes=32, sha256='d' * 64),
        dict(nodeId=4, model='output', identity=list(OUT0), bytes=64, sha256='e' * 64,
             path='/build/out0.o', completedCloseSequence=500, producerPid=11,
             producerCaptureSequence=498, phase='compile', inputSetId=0),
        dict(nodeId=5, model='output', identity=list(OUT1), bytes=32, sha256='0' * 64,
             path='/build/out1.o', completedCloseSequence=700, producerPid=12,
             producerCaptureSequence=698, phase='compile', inputSetId=1),
    ]
    node_for = {0: 0, 1: 1, 2: 2, 3: 3}

    def edge_for(index):
        row = inputs[index]
        read = row.get('regularRead')
        return [node_for[index], row['entrySequence'], row['captureSequence'],
                row['inputModel'], row.get('lifetimeLeaseSequence'),
                read['form'] if read else None, read['fd'] if read else None,
                read['rangeStart'] if read else None,
                read['consumedLength'] if read else None,
                read['result'] if read else None,
                read['exitSequence'] if read else None]

    graph = dict(
        schemaVersion=1, model='compact-deduplicated-causal-graph-v1',
        nodeCount=len(nodes), edgeSetCount=2,
        edgeCount=len(witness[0]['inputIds']) + len(witness[1]['inputIds']),
        edgeLayout=['inputNodeId', 'entrySequence', 'captureSequence', 'inputModel',
                    'lifetimeLeaseSequence', 'readForm', 'readFd', 'readRangeStart',
                    'readConsumedLength', 'readResult', 'readExitSequence'],
        nodes=nodes,
        inputSets=[dict(setId=0, edges=[edge_for(i) for i in witness[0]['inputIds']]),
                   dict(setId=1, edges=[edge_for(i) for i in witness[1]['inputIds']])])

    custody = [
        dict(leaseSequence=5, identity=list(A), bytes=16, sha256='a' * 64, entrySequence=100,
             captureSequence=102, acquisitionEntrySequence=90, exitSequence=103,
             phase='compile', model='kernel-held-read-lease-v1'),
        dict(leaseSequence=5, identity=list(B), bytes=16, sha256='b' * 64, entrySequence=200,
             captureSequence=202, acquisitionEntrySequence=90, exitSequence=203,
             phase='compile', model='kernel-held-read-lease-v1'),
    ]
    source_class = [
        dict(leaseSequence=5, identity=list(A), bytes=16, sha256='a' * 64,
             resolvedPath='/usr/include/a.h', originClass='unresolved',
             originDetail='no closed same-private origin', phase='compile'),
    ]
    return inputs, witness, graph, custody, source_class



def _column_values(column):
    """Per-row values of a carried column in EITHER accepted form."""
    return column if isinstance(column, list) else column['values'] if column['form'] == 'raw' else column['values']


def _column_codes(column):
    return None if isinstance(column, list) else column.get('codes')


def encode(inputs=None, witness=None, graph=None, custody=None, source_class=None):
    if inputs is None:
        inputs, witness, graph, custody, source_class = sample()
    return codec.encode(inputs, witness, graph, custody, source_class)


def normalise(row):
    value = dict(row)
    value.pop('inputId', None)
    value['graphKey'] = list(value.get('graphKey') or [])
    return json.loads(json.dumps(value, sort_keys=True, default=list))


class TransportCodecTest(unittest.TestCase):
    def test_round_trip_is_lossless(self):
        inputs, witness, graph, custody, source_class = sample()
        decoded = codec.decode(encode(inputs, witness, graph, custody, source_class))
        di, dw, dg, dc, ds = decoded
        codec.assert_lossless(inputs, witness, di, dw)
        codec.assert_graph_lossless(graph, dg)
        self.assertEqual([normalise(r) for r in inputs], [normalise(r) for r in di])
        self.assertEqual(custody, json.loads(json.dumps(dc, default=list)))
        self.assertEqual(source_class, json.loads(json.dumps(ds, default=list)))

    def test_unknown_future_field_survives_the_wire(self):
        inputs, witness, graph, custody, source_class = sample()
        di, dw, _, _, _ = codec.decode(encode(inputs, witness, graph, custody, source_class))
        self.assertEqual({'nested': [1, 2, 3]}, di[0]['futureProofField'])
        self.assertEqual('preserved', dw[0]['futureWitnessField'])

    def test_key_presence_is_preserved(self):
        inputs, witness, graph, custody, source_class = sample()
        di, _, _, _, _ = codec.decode(encode(inputs, witness, graph, custody, source_class))
        # the mapping row never carried resolvedPath; the round trip must not add it
        mapping = [r for r in di if r['inputModel'] == 'mapping'][0]
        self.assertNotIn('resolvedPath', mapping)
        self.assertIn('resolvedPath', inputs[0])
        self.assertIn('resolvedPath', di[0])

    def test_two_byte_versions_of_one_identity_stay_distinct(self):
        inputs, witness, graph, custody, source_class = sample()
        di, _, _, _, _ = codec.decode(encode(inputs, witness, graph, custody, source_class))
        versions = [r for r in di if r['identity'] == A]
        self.assertEqual(2, len(versions))
        self.assertEqual(2, len({(r['bytes'], r['sha256']) for r in versions}))

    def test_six_decimal_identities_survive_as_strings(self):
        big = ['18446744073709551615'] * 6
        inputs, witness, graph, _, _ = sample()
        inputs[0]['identity'] = big
        graph['nodes'][0]['identity'] = list(big)
        di, _, _, _, _ = codec.decode(encode(inputs, witness, graph))
        self.assertEqual(big, di[0]['identity'])
        self.assertTrue(all(isinstance(v, str) for v in di[0]['identity']))

    def test_graph_round_trips_edge_for_edge(self):
        inputs, witness, graph, _, _ = sample()
        _, _, dg, _, _ = codec.decode(encode(inputs, witness, graph))
        self.assertEqual(graph['nodeCount'], dg['nodeCount'])
        self.assertEqual(graph['edgeCount'], dg['edgeCount'])
        for before, after in zip(graph['inputSets'], dg['inputSets']):
            self.assertEqual([list(e) for e in before['edges']],
                             [list(e) for e in after['edges']])

    def test_custody_and_source_class_tables_survive(self):
        inputs, witness, graph, custody, source_class = sample()
        _, _, _, dc, ds = codec.decode(encode(inputs, witness, graph, custody, source_class))
        self.assertEqual(custody, json.loads(json.dumps(dc, default=list)))
        self.assertEqual(source_class, json.loads(json.dumps(ds, default=list)))
        for row in dc:
            self.assertIn('captureSequence', row)
            self.assertIn('acquisitionEntrySequence', row)

    def test_transport_is_smaller_than_the_inlined_table_at_scale(self):
        # 10 outputs x 40 reads over 40 shared sources: the real independent-PID shape
        inputs, witness, graph = [], [], None
        for o in range(10):
            ids = []
            for j in range(40):
                n = o * 40 + j
                ids.append(n)
                inputs.append(dict(
                    inputId=n, entrySequence=10 + n * 10, captureSequence=12 + n * 10,
                    identity=['1', str(4000 + j), '33188', '16', '11', '12'], bytes=16,
                    sha256=('a' if j % 2 else 'b') * 64,
                    resolvedPath='/usr/include/h%d.h' % j, protection=1, flags=0,
                    lifetimeLeaseSequence=5, executable=False, inputModel='regular-read',
                    regularRead=dict(form='pread64', fd=3, readLeaseSequence=5, rangeStart=0,
                                     consumedLength=16, result=16, exitSequence=13 + n * 10,
                                     generation=GENERATION, iovcnt=None, iovLengths=None),
                    graphKey=('read', 12 + n * 10)))
            witness.append(dict(path='/build/o%d.o' % o, bytes=64, sha256='c' * 64,
                                identity=['1', str(9000 + o), '33152', '64', '21', '22'],
                                completedCloseSequence=5000 + o, producerCaptureSequence=4990 + o,
                                producerPid=11, phase='compile', inputComplete=True,
                                readOperations=40, inputObligationCount=40, unexplainedReads=[],
                                mappingInputCount=0, readInputCount=40, inputIds=ids,
                                execImage=dict(pid=11, phase='compile', exe='/usr/bin/cc',
                                               identity=list(EXEC), bytes=8, sha256='f' * 64)))
        nodes = [dict(nodeId=j, model='regular-read', identity=['1', str(4000 + j), '33188', '16', '11', '12'],
                      bytes=16, sha256=('a' if j % 2 else 'b') * 64) for j in range(40)]
        for o in range(10):
            nodes.append(dict(nodeId=40 + o, model='output',
                              identity=['1', str(9000 + o), '33152', '64', '21', '22'], bytes=64,
                              sha256='c' * 64, path='/build/o%d.o' % o,
                              completedCloseSequence=5000 + o, producerPid=11,
                              producerCaptureSequence=4990 + o, phase='compile', inputSetId=o))
        sets = [dict(setId=o, edges=[
            [j, 10 + (o * 40 + j) * 10, 12 + (o * 40 + j) * 10, 'regular-read', 5,
             'pread64', 3, 0, 16, 16, 13 + (o * 40 + j) * 10] for j in range(40)]) for o in range(10)]
        graph = dict(schemaVersion=1, model='compact-deduplicated-causal-graph-v1',
                     nodeCount=50, edgeSetCount=10, edgeCount=400, nodes=nodes, inputSets=sets)
        transport = codec.encode(inputs, witness, graph)
        di, dw, dg, _, _ = codec.decode(transport)
        codec.assert_lossless(inputs, witness, di, dw)
        codec.assert_graph_lossless(graph, dg)
        encode_json = lambda value: json.dumps(value, separators=(',', ':'), default=list)
        replaced = len(encode_json(inputs)) + len(encode_json(graph))
        self.assertLess(len(encode_json(transport)) * 3, replaced)

    # ---- structural refusals -------------------------------------------------

    def test_missing_read_id_reference_is_refused(self):
        broken = copy.deepcopy(encode())
        broken['outputs'][0]['inputIds'] = [0, 1, 10 ** 9]
        with self.assertRaises(ValueError):
            codec.decode(broken)

    def test_duplicate_source_id_is_refused(self):
        broken = copy.deepcopy(encode())
        broken['sources'][1]['sourceId'] = broken['sources'][0]['sourceId']
        with self.assertRaises(ValueError):
            codec.decode(broken)

    def test_missing_table_is_refused(self):
        broken = copy.deepcopy(encode())
        del broken['sources']
        with self.assertRaises(ValueError):
            codec.decode(broken)

    def test_truncated_read_column_is_refused(self):
        broken = copy.deepcopy(encode())
        column = broken['readColumns'][0]
        if isinstance(column, list):
            broken['readColumns'][0] = column[:-1]
        elif column['form'] == 'raw':
            column['values'] = column['values'][:-1]
        else:
            # shortening only the index list must be refused as well
            column['codes'] = column['codes'][:-1]
        with self.assertRaises(ValueError):
            codec.decode(broken)

    def test_wrong_model_or_schema_is_refused(self):
        for mutate in (lambda t: t.__setitem__('model', 'other'),
                       lambda t: t.__setitem__('schemaVersion', 1)):
            broken = copy.deepcopy(encode())
            mutate(broken)
            with self.assertRaises(ValueError):
                codec.decode(broken)

    def test_count_mismatch_is_refused(self):
        broken = copy.deepcopy(encode())
        broken['readCount'] = broken['readCount'] + 1
        with self.assertRaises(ValueError):
            codec.decode(broken)

    def test_foreign_graph_read_is_refused(self):
        broken = copy.deepcopy(encode())
        broken['graph']['inputSets'][0]['readIds'].append(10 ** 9)
        with self.assertRaises(ValueError):
            codec.decode(broken)

    def test_foreign_source_reference_is_refused(self):
        broken = copy.deepcopy(encode())
        column = broken['readColumns'][0]
        if isinstance(column, list):
            column[0] = 10 ** 9
        elif column['form'] == 'raw':
            # raw-dict form still carries the literal per-row values
            column['values'][0] = 10 ** 9
        else:
            # A dict column stores DISTINCT values; the foreign-reference check
            # applies to the decoded per-row sourceId, so redirect a row code to a
            # legal index that carries an out-of-range source id.
            column['values'].append(10 ** 9)
            column['codes'][0] = len(column['values']) - 1
        with self.assertRaises(ValueError):
            codec.decode(broken)


class SharedSourceExtraTests(unittest.TestCase):
    """ROOT counterexample: two reads of the SAME exact source may carry
    DIFFERENT unknown per-read top-level extras. Both must survive; the codec may
    never collapse them to the first read's value (that is silent fact loss, the
    exact class of bug this transport repair exists to prevent)."""

    def base(self, **over):
        row = dict(entrySequence=10, captureSequence=12,
                   identity=['1', '4', '33188', '16', '1', '2'], bytes=16,
                   sha256='a' * 64, resolvedPath='/usr/include/h.h', protection=1,
                   flags=0, lifetimeLeaseSequence=5, executable=False,
                   inputModel='regular-read',
                   regularRead=dict(form='pread64', fd=3, readLeaseSequence=5,
                                    rangeStart=0, consumedLength=16, result=16,
                                    exitSequence=13,
                                    generation=dict(identity=['1', '4', '33188', '16', '1', '2'],
                                                    flags=0, position=0),
                                    iovcnt=None, iovLengths=None))
        row.update(over)
        return row

    def test_different_top_level_extras_on_one_shared_source_survive(self):
        first, second = self.base(inputId=0, perRead=1), self.base(inputId=1, perRead=2)
        wire = codec.encode([first, second], [], None, [], [])
        decoded = codec.decode(wire)[0]
        self.assertEqual([row.get('perRead') for row in decoded], [1, 2])

    def test_different_nested_regular_read_extras_also_survive(self):
        first = self.base(inputId=0)
        first['regularRead']['perRead'] = 'first'
        second = self.base(inputId=1)
        second['regularRead']['perRead'] = 'second'
        decoded = codec.decode(codec.encode([first, second], [], None, [], []))[0]
        self.assertEqual([row['regularRead'].get('perRead') for row in decoded],
                         ['first', 'second'])

    def test_the_source_row_carries_no_read_scoped_extras(self):
        first, second = self.base(inputId=0, perRead=1), self.base(inputId=1, perRead=2)
        wire = codec.encode([first, second], [], None, [], [])
        self.assertEqual([row.get('extra') for row in wire['sources']], [{}])

    def test_a_structured_shared_source_still_dedupes_once(self):
        first, second = self.base(inputId=0), self.base(inputId=1)
        wire = codec.encode([first, second], [], None, [], [])
        self.assertEqual(wire['sourceCount'], 1)


class RealRestoredShapeTests(unittest.TestCase):
    """The ACTUAL restored-Q9 read-association shape, at the measured scale.

    Every output has its OWN producer PID and its OWN edge set, and the custody /
    sourceClass tables carry ONE ROW PER READ ASSOCIATION (24000), including many
    reads of the SAME held header under DIFFERENT PIDs and entry sequences. An
    earlier fixture used one row per source and one shared edge set, which hid
    the real wire cost.
    """

    OUTPUTS, SHARED = 600, 40

    def build(self):
        inputs, witness, graph, custody, classes = [], [], None, [], []
        nodes, sets = [], []
        for out in range(self.OUTPUTS):
            pid = 1000 + out
            ids = []
            for j in range(self.SHARED):
                n = out * self.SHARED + j
                identity = ['1', str(4000 + j), '33188', '16', '11', '12']
                ids.append(n)
                inputs.append(dict(
                    inputId=n, entrySequence=10 + n * 10, captureSequence=12 + n * 10,
                    identity=identity, bytes=16, sha256=('a' if j % 2 else 'b') * 64,
                    resolvedPath='/usr/include/h%d.h' % j, protection=1, flags=0,
                    lifetimeLeaseSequence=5, executable=False, inputModel='regular-read',
                    regularRead=dict(form='pread64', fd=3, readLeaseSequence=5, rangeStart=0,
                                     consumedLength=16, result=16, exitSequence=13 + n * 10,
                                     generation=dict(identity=identity[:], flags=0, position=0),
                                     iovcnt=None, iovLengths=None),
                    graphKey=('read', 12 + n * 10)))
                # ONE row per READ association, not per source. The SAME lease 5 is
                # legitimately held by every producer PID for the SAME header.
                custody.append(dict(leaseSequence=5, identity=identity, bytes=16,
                                    sha256=('a' if j % 2 else 'b') * 64,
                                    entrySequence=10 + n * 10, captureSequence=12 + n * 10,
                                    acquisitionEntrySequence=1, exitSequence=13 + n * 10,
                                    phase='compile', pid=pid,
                                    model='kernel-held-read-lease-v1'))
                classes.append(dict(leaseSequence=5, identity=identity, pid=pid,
                                    entrySequence=10 + n * 10, bytes=16,
                                    sha256=('a' if j % 2 else 'b') * 64,
                                    resolvedPath='/usr/include/h%d.h' % j,
                                    originClass='signed-debian-installed',
                                    originDetail={'dependency': 'fixture',
                                                  'registrationSequence': j},
                                    phase='compile'))
            witness.append(dict(path='/build/o%d.o' % out, bytes=64, sha256='c' * 64,
                                identity=['1', str(9000 + out), '33152', '64', '21', '22'],
                                completedCloseSequence=500000 + out,
                                producerCaptureSequence=499990 + out, producerPid=pid,
                                phase='compile', inputComplete=True,
                                readOperations=self.SHARED,
                                inputObligationCount=self.SHARED, unexplainedReads=[],
                                mappingInputCount=0, readInputCount=self.SHARED, inputIds=ids,
                                execImage=dict(pid=pid, phase='compile', exe='/usr/bin/cc',
                                               identity=['1', '500', '33261', '8', '11', '12'],
                                               bytes=8, sha256='f' * 64)))
            edges = [[j, 10 + (out * self.SHARED + j) * 10,
                      12 + (out * self.SHARED + j) * 10, 'regular-read', 5, 'pread64', 3,
                      0, 16, 16, 13 + (out * self.SHARED + j) * 10]
                     for j in range(self.SHARED)]
            sets.append(dict(setId=out, edges=edges))
        for j in range(self.SHARED):
            identity = ['1', str(4000 + j), '33188', '16', '11', '12']
            nodes.append(dict(nodeId=j, model='regular-read', identity=identity, bytes=16,
                              sha256=('a' if j % 2 else 'b') * 64))
        for out in range(self.OUTPUTS):
            nodes.append(dict(nodeId=self.SHARED + out, model='output',
                              identity=['1', str(9000 + out), '33152', '64', '21', '22'],
                              bytes=64, sha256='c' * 64, path='/build/o%d.o' % out,
                              completedCloseSequence=500000 + out,
                              producerCaptureSequence=499990 + out,
                              producerPid=1000 + out, phase='compile', inputSetId=out))
        graph = dict(schemaVersion=1, model='compact-deduplicated-causal-graph-v1',
                     nodeCount=len(nodes), edgeSetCount=len(sets), edgeCount=len(inputs),
                     nodes=nodes, inputSets=sets)
        return inputs, witness, graph, custody, classes

    def test_all_read_associations_survive_the_wire(self):
        inputs, witness, graph, custody, classes = self.build()
        self.assertEqual(len(inputs), 24000)
        self.assertEqual(len(custody), 24000)
        self.assertEqual(len(classes), 24000)
        self.assertEqual(graph['edgeCount'], 24000)
        wire = codec.encode(inputs, witness, graph, custody, classes)
        decoded_inputs, decoded_witness, decoded_graph, decoded_custody, decoded_classes = \
            codec.decode(wire)
        codec.assert_lossless(inputs, witness, decoded_inputs, decoded_witness)
        codec.assert_graph_lossless(graph, decoded_graph)
        self.assertEqual(decoded_custody, custody)
        self.assertEqual(decoded_classes, classes)
        self.assertEqual(len(decoded_custody), 24000)
        self.assertEqual(len(decoded_classes), 24000)
        # the SAME header read under many PIDs keeps every distinct association
        self.assertEqual(len({(r['pid'], r['entrySequence']) for r in decoded_custody}), 24000)
        self.assertEqual(len({r['pid'] for r in decoded_custody}), self.OUTPUTS)

    def test_the_complete_shape_fits_the_existing_metadata_budget(self):
        inputs, witness, graph, custody, classes = self.build()
        wire = codec.encode(inputs, witness, graph, custody, classes)
        size = len(json.dumps(wire, separators=(',', ':')).encode())
        self.assertLess(size, 4 * 1024 ** 2, 'complete per-read wire must fit 4MiB')
        decoded = codec.decode(wire)
        self.assertEqual(len(decoded[3]), 24000)
        self.assertEqual(len(decoded[4]), 24000)
        self.assertEqual(decoded[2]['edgeCount'], 24000)

    def test_a_foreign_row_code_is_refused(self):
        inputs, witness, graph, custody, classes = self.build()
        wire = codec.encode(inputs, witness, graph, custody, classes)
        column = wire['custody']['columns'][0]
        self.assertEqual(column['form'], 'dict')
        broken = copy.deepcopy(wire)
        broken['custody']['columns'][0]['codes'][0] = len(column['values']) + 5
        with self.assertRaises(ValueError):
            codec.decode(broken)

    def test_a_shortened_row_index_is_refused(self):
        inputs, witness, graph, custody, classes = self.build()
        wire = codec.encode(inputs, witness, graph, custody, classes)
        broken = copy.deepcopy(wire)
        broken['custody']['columns'][0]['codes'] = broken['custody']['columns'][0]['codes'][:-1]
        with self.assertRaises(ValueError):
            codec.decode(broken)

    def test_a_damaged_dictionary_is_refused(self):
        inputs, witness, graph, custody, classes = self.build()
        wire = codec.encode(inputs, witness, graph, custody, classes)
        # The codec is a pure transport: it REFUSES structural damage, and it does
        # not silently "repair" or narrow a damaged evidence value. What it must
        # never do is accept a shape it cannot account for row-for-row.
        for mutate in (
            lambda w: w['sourceClass']['columns'][0].__setitem__('form', 'mangled'),
            lambda w: w['sourceClass']['columns'][0].__setitem__('values', 'not-a-list'),
            lambda w: w['sourceClass']['columns'][0].pop('codes'),
            lambda w: w['sourceClass'].__setitem__('columns', w['sourceClass']['columns'][:-1]),
            lambda w: w['custody'].__setitem__('count', w['custody']['count'] + 1),
        ):
            broken = copy.deepcopy(wire)
            mutate(broken)
            with self.assertRaises(ValueError):
                codec.decode(broken)


if __name__ == '__main__':
    unittest.main(verbosity=2)
