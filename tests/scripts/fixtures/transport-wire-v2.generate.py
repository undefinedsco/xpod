"""Deterministic generator for `transport-wire-v2.json`.

This is NOT a test assertion source and NOT an authority. It exists so the sealed
fixture beside it can be reproduced byte-for-byte and audited by SHA-256.

It builds a compact but contract-complete sample (two shared SOURCE rows, four
READ rows spanning a scalar pread, an iovec preadv, a second byte version of one
identity, and a mapping input) and runs it through the REAL codec encoder.

Usage (from the repository root):
    python3 tests/scripts/fixtures/transport-wire-v2.generate.py > tests/scripts/fixtures/transport-wire-v2.json
"""
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


codec = load('transport_codec', 'qlever/scripts/sdk-generated-producer-transport.py')

GENERATION = {'identity': ['1', '7', '33188', '16', '11', '12'], 'flags': 0, 'position': 0}
A = ['1', '7', '33188', '16', '11', '12']
B = ['1', '8', '33188', '16', '11', '12']
EXEC = ['1', '5', '33261', '8', '1', '1']
OUT0 = ['1', '9000', '33152', '64', '21', '22']
OUT1 = ['1', '9001', '33152', '32', '21', '22']


def read_row(read_id, entry, capture, source, model='regular-read', resolved='/usr/include/a.h',
             form='pread64', fd=3, lease=5, start=0, consumed=16, result=16, exit_=None,
             iovcnt=None, iov_lengths=None, extra=None):
    row = dict(inputId=read_id, entrySequence=entry, captureSequence=capture,
               identity=list(source), bytes=consumed if consumed else 16, sha256=source and None or None)
    row.pop('sha256')
    row.update(dict(entrySequence=entry, captureSequence=capture, identity=list(source),
                    protection=1, flags=0, lifetimeLeaseSequence=lease, executable=(model == 'mapping'),
                    inputModel=model, graphKey=(('mapping' if model == 'mapping' else 'read'), capture)))
    if resolved is not None:
        row['resolvedPath'] = resolved
    if model == 'regular-read':
        row['regularRead'] = dict(form=form, fd=fd, readLeaseSequence=lease, rangeStart=start,
                                  consumedLength=consumed, result=result,
                                  exitSequence=exit_ if exit_ is not None else capture + 1,
                                  generation=GENERATION, iovcnt=iovcnt, iovLengths=iov_lengths)
    if extra:
        row.update(extra)
    return row


def build():
    inputs = [
        dict(read_row(0, 100, 102, A, consumed=16, exit_=103), bytes=16, sha256='a' * 64),
        dict(read_row(1, 200, 202, B, form='preadv', fd=4, start=8, consumed=16, exit_=203,
                      iovcnt=2, iov_lengths=[8, 8]), bytes=16, sha256='b' * 64),
        # a SECOND byte version of identity A (larger, different digest)
        dict(read_row(2, 300, 302, A, start=0, consumed=24, result=24, exit_=303), bytes=24, sha256='c' * 64),
        dict(read_row(3, 400, 402, B, model='mapping', resolved=None), bytes=32, sha256='d' * 64),
    ]
    # an explicitly future/unknown field, which the transport must carry verbatim
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
    # Edges are DERIVED from the read rows, never hand-written, so the two carry
    # exactly one truth: the graph is a projection of the same observations.
    node_for = {0: 0, 1: 1, 2: 2, 3: 3}

    def edge_for(input_index):
        row = inputs[input_index]
        read = row.get('regularRead')
        return [node_for[input_index], row['entrySequence'], row['captureSequence'],
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
        inputSets=[
            dict(setId=0, edges=[edge_for(i) for i in witness[0]['inputIds']]),
            dict(setId=1, edges=[edge_for(i) for i in witness[1]['inputIds']]),
        ])

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
        dict(leaseSequence=5, identity=list(B), bytes=16, sha256='b' * 64,
             resolvedPath='/usr/include/b.h', originClass='unresolved',
             originDetail='no closed same-private origin', phase='compile'),
    ]

    transport = codec.encode(inputs, witness, graph, custody, source_class)
    return dict(__fixture__='transport-wire-v2',
                transport=transport, inputs=inputs, witness=witness, graph=graph,
                custody=custody, sourceClass=source_class)


if __name__ == '__main__':
    json.dump(build(), sys.stdout, sort_keys=True, separators=(',', ':'))
    sys.stdout.write('\n')
