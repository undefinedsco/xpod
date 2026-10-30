"""ACTUAL CLI emit projection: the real scanner strips the five generated
tables ONLY when a valid closed transport is present.

This exercises the real `sdk-generated-source-originals.py` `observe()` return
path (the same function the CLI prints) rather than a hand-built payload, and
measures the genuine serialized stdout bytes at a realistic shared-source scale.
"""
import copy
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

codec = load('emit_codec', ROOT / 'scripts/sdk-generated-producer-transport.py')
bindings = load('emit_bindings', ROOT / 'scripts/sdk-generation-multiprocess-bindings.py')

GENERATION = dict(identity=['1', '4000', '33188', '16', '11', '12'], flags=0, position=0)
EXEC = ['1', '500', '33261', '8', '11', '12']

def scale(outputs, shared):
    """The real multi-producer shared-header shape: N outputs x M shared reads."""
    inputs, witness, edges_by_output = [], [], []
    for o in range(outputs):
        ids = []
        for j in range(shared):
            n = o * shared + j
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
                            completedCloseSequence=500000 + o, producerCaptureSequence=499990 + o,
                            producerPid=11, phase='compile', inputComplete=True,
                            readOperations=shared, inputObligationCount=shared,
                            unexplainedReads=[], mappingInputCount=0, readInputCount=shared,
                            inputIds=ids,
                            execImage=dict(pid=11, phase='compile', exe='/usr/bin/cc',
                                           identity=list(EXEC), bytes=8, sha256='f' * 64)))
    nodes = [dict(nodeId=j, model='regular-read',
                  identity=['1', str(4000 + j), '33188', '16', '11', '12'], bytes=16,
                  sha256=('a' if j % 2 else 'b') * 64) for j in range(shared)]
    nodes += [dict(nodeId=shared + o, model='output',
                   identity=['1', str(9000 + o), '33152', '64', '21', '22'], bytes=64,
                   sha256='c' * 64, path='/build/o%d.o' % o,
                   completedCloseSequence=500000 + o, producerCaptureSequence=499990 + o,
                   producerPid=11, phase='compile', inputSetId=0) for o in range(outputs)]
    # REAL restored-Q9 shape: ONE custody/sourceClass row per actual READ
    # ASSOCIATION (24000 rows), each carrying its own pid/entry, NOT one row per
    # shared source. A single held lease is legitimately reused by many producer
    # PIDs, so the association must never be deduplicated down to the lease.
    custody, source_class = [], []
    for out, row in enumerate(witness):
        pid = 1000 + out
        row['producerPid'] = pid
        row['execImage']['pid'] = pid
        nodes[shared + out]['producerPid'] = pid
        nodes[shared + out]['inputSetId'] = out
        edges = []
        for j, read_id in enumerate(row['inputIds']):
            read = inputs[read_id]
            regular = read['regularRead']
            custody.append(dict(leaseSequence=regular['readLeaseSequence'],
                                identity=read['identity'], bytes=read['bytes'],
                                sha256=read['sha256'], entrySequence=read['entrySequence'],
                                captureSequence=regular.get('captureSequence', read['captureSequence']),
                                acquisitionEntrySequence=1, exitSequence=regular['exitSequence'],
                                phase=row['phase'], pid=pid,
                                model='kernel-held-read-lease-v1'))
            source_class.append(dict(leaseSequence=regular['readLeaseSequence'],
                                     identity=read['identity'], pid=pid,
                                     entrySequence=read['entrySequence'],
                                     bytes=read['bytes'], sha256=read['sha256'],
                                     resolvedPath=read.get('resolvedPath'),
                                     originClass='signed-debian-installed',
                                     originDetail={'dependency': 'fixture'}, phase=row['phase']))
            edges.append([j, read['entrySequence'], read['captureSequence'], read['inputModel'],
                          read['lifetimeLeaseSequence'], regular['form'], regular['fd'],
                          regular['rangeStart'], regular['consumedLength'], regular['result'],
                          regular['exitSequence']])
        edges_by_output.append(dict(setId=out, edges=edges))
    # EACH output owns its OWN edge set: the real shape has 600 sets / 24000
    # edges, not one 40-edge set reused by 600 outputs.
    graph = dict(schemaVersion=1, model='compact-deduplicated-causal-graph-v1',
                 nodeCount=len(nodes), edgeSetCount=len(edges_by_output),
                 edgeCount=len(inputs), nodes=nodes, inputSets=edges_by_output)
    return inputs, witness, graph, custody, source_class



TRANSPORT_FIELDS = ('verifiedGeneratedProducerInputs', 'verifiedGeneratedProducerWitness',
                    'verifiedGeneratedProducerGraph', 'verifiedRegularReadCustody',
                    'verifiedRegularReadSourceClass')

# The ONE production emission projection. This is the same function the scanner
# CLI calls inside observe(); the test does NOT re-implement it.
cli = load('emit_cli', ROOT / 'scripts/sdk-generated-source-originals.py')

def emit(payload):
    return cli.emit_projection(copy.deepcopy(payload))

class EmitProjectionTests(unittest.TestCase):
    def payload(self, outputs=600, shared=40):
        inputs, witness, graph, custody, source_class = scale(outputs, shared)
        transport = codec.encode(inputs, witness, graph, custody, source_class)
        return dict(
            schemaVersion=1, pending=[], verifiedGeneratedProducerTransport=transport,
            verifiedGeneratedProducerInputs=inputs, verifiedGeneratedProducerWitness=witness,
            verifiedGeneratedProducerGraph=graph, verifiedRegularReadCustody=custody,
            verifiedRegularReadSourceClass=source_class,
            toolchainOperationCoverage=dict(schemaVersion=1, operations=[], pending=[]))

    def test_a_valid_transport_strips_exactly_the_five_generated_tables(self):
        payload = self.payload(outputs=8, shared=4)
        out = emit(payload)
        for name in TRANSPORT_FIELDS:
            self.assertNotIn(name, out)
        # everything else survives untouched
        self.assertIn('verifiedGeneratedProducerTransport', out)
        self.assertEqual(out['toolchainOperationCoverage'], payload['toolchainOperationCoverage'])
        self.assertEqual(out['schemaVersion'], payload['schemaVersion'])
        self.assertEqual(out['pending'], payload['pending'])

    def test_the_stripped_wire_is_under_the_metadata_budget_and_decodes_fully(self):
        payload = self.payload(outputs=600, shared=40)
        before = len(json.dumps(payload, separators=(',', ':')).encode())
        out = emit(payload)
        after = len(json.dumps(out, separators=(',', ':')).encode())
        # the un-stripped shape is the ~19MB regression
        self.assertGreater(before, 4 * 1024 ** 2)
        self.assertLess(after, 4 * 1024 ** 2)
        # and the transport still decodes to the complete facts
        decoded_inputs, decoded_witness, _graph, _custody, _class = codec.decode(
            out['verifiedGeneratedProducerTransport'])
        self.assertEqual(len(decoded_witness), 600)
        self.assertEqual(len(decoded_inputs), 600 * 40)

    def test_an_absent_transport_keeps_the_legacy_arrays(self):
        payload = self.payload(outputs=4, shared=2)
        del payload['verifiedGeneratedProducerTransport']
        out = emit(payload)
        for name in TRANSPORT_FIELDS:
            self.assertIn(name, out)

    def test_a_present_but_malformed_transport_fails_closed(self):
        payload = self.payload(outputs=4, shared=2)
        payload['verifiedGeneratedProducerTransport'] = dict(schemaVersion=9,
            model='indexed-generated-producer-transport-v2')
        with self.assertRaises(ValueError):
            emit(payload)

    def test_a_missing_legacy_table_cannot_be_silently_dropped(self):
        payload = self.payload(outputs=4, shared=2)
        payload['verifiedGeneratedProducerGraph'] = None
        del payload['verifiedGeneratedProducerGraph']
        with self.assertRaises(ValueError):
            emit(payload)

if __name__ == '__main__':
    unittest.main(verbosity=2)
