"""Versioned, LOSSLESS generated-producer transport codec (encode + decode).

WHY THIS EXISTS
The scanner wire used to inline every per-output input record. When independent
producer PIDs each read the SAME canonical header originals, those byte facts are
repeated once per read (once per producer), and the whole wire grows
O(outputs x inputs). The 200-producer case already exceeds the 4 MiB scanner
budget. Nothing about that is an authority problem -- it is a transport problem.

WHAT IS FACTORED APART
  SOURCE  -- shared, immutable file/FD-generation/source state, stored ONCE per
             distinct (identity, bytes, sha256, resolvedPath, generation).
  READ    -- the per-read causal observation: its own entry/capture/lease/
             range/IOV/result/exit facts. It references a source by integer id.
  OUTPUT  -- per-output references: which reads it owns, plus its own close.

Losslessness is explicit, not claimed:
  * every known field of every input record is carried in a fixed position;
  * `graphKey` is a pure function of (inputModel, captureSequence) and is
    RE-DERIVED on decode -- `assert_lossless` still checks the round trip;
  * any field this version does not know about is carried verbatim in an
    explicit `extra` slot, so a later field addition survives the wire. If that
    merge slot itself is unusable the decoder REFUSES rather than narrowing.

This module is pure transport. It grants no authority and issues no capability.
It is a testable twin of the TypeScript decoder; the TS side is the consumer.
"""
import json

MODEL = 'indexed-generated-producer-transport-v2'

# Closed, ordered layouts. Position is the contract; do not reorder.
SOURCE_FIELDS = ('identity', 'bytes', 'sha256', 'resolvedPath', 'generation')
READ_FIELDS = ('sourceId', 'entrySequence', 'captureSequence', 'inputModel',
               'lifetimeLeaseSequence', 'protection', 'flags', 'executable',
               'form', 'fd', 'readLeaseSequence', 'rangeStart', 'consumedLength',
               'result', 'exitSequence', 'iovcnt', 'iovLengths')
CUSTODY_FIELDS = ('leaseSequence', 'identity', 'bytes', 'sha256', 'entrySequence',
                  'captureSequence', 'acquisitionEntrySequence', 'exitSequence',
                  'phase', 'model')
SOURCECLASS_FIELDS = ('leaseSequence', 'identity', 'bytes', 'sha256', 'resolvedPath',
                      'originClass', 'originDetail', 'phase')
# Top-level input fields that belong to the READ (or to the source identity that
# is already carried), never to the shared SOURCE extras slot.
READ_SCOPED_INPUT_FIELDS = ('inputId', 'regularRead', 'graphKey', 'inputModel',
                            'entrySequence', 'captureSequence',
                            'lifetimeLeaseSequence', 'protection', 'flags',
                            'executable')

OUTPUT_FIELDS = ('path', 'bytes', 'sha256', 'identity', 'completedCloseSequence',
                 'producerCaptureSequence', 'producerPid', 'phase', 'execImage',
                 'inputComplete', 'readOperations', 'inputObligationCount',
                 'mappingInputCount', 'readInputCount', 'unexplainedReads')


def _graph_key(input_model, capture_sequence):
    """The one field that is a pure function of two carried fields."""
    return ('mapping' if input_model == 'mapping' else 'read', capture_sequence)


def _is_scalar(value):
    """A JSON scalar that can be interned in a dictionary."""
    return value is None or isinstance(value, (str, int, float, bool))


def _encode_column(values):
    """Encode ONE column, interning repeated values.

    The per-read evidence tables repeat the same handful of values in every row
    (identity tuples, sha256, phase, lease id, model, class, resolved path, and
    the structured `originDetail` / per-read extras). Sending each distinct value
    ONCE plus a per-row index keeps ONE authoritative value set while making the
    wire O(distinct values + rows) instead of O(rows x width).

    Interning is by exact canonical JSON of the value, so structured values
    (identity tuples, generation, iovLengths, originDetail) are preserved
    verbatim -- never approximated, sampled or re-derived. The layout is
    self-describing, so a decoder that does not understand a column form REFUSES
    rather than guessing.
    """
    dictionary = []
    index = {}
    codes = []
    for value in values:
        key = json.dumps(value, sort_keys=True, separators=(',', ':'))
        slot = index.get(key)
        if slot is None:
            slot = len(dictionary)
            index[key] = slot
            dictionary.append(value)
        codes.append(slot)
    # A per-row index costs more than the raw values unless it collapses.
    if len(dictionary) * 2 < len(values):
        return {'form': 'dict', 'values': dictionary, 'codes': codes}
    return {'form': 'raw', 'values': values}


def _decode_column(encoded, count, what, name):
    if not isinstance(encoded, dict) or encoded.get('form') not in ('raw', 'dict'):
        raise ValueError(f'generated producer transport {what} column {name} form differs')
    values = encoded['values']
    if not isinstance(values, list):
        raise ValueError(f'generated producer transport {what} column {name} values required')
    if encoded['form'] == 'raw':
        if len(values) != count:
            raise ValueError(f'generated producer transport {what} column {name} length differs')
        return list(values)
    codes = encoded.get('codes')
    if not isinstance(codes, list) or len(codes) != count:
        raise ValueError(f'generated producer transport {what} column {name} codes differ')
    for code in codes:
        if not isinstance(code, int) or isinstance(code, bool) or code < 0 or code >= len(values):
            raise ValueError(f'generated producer transport {what} column {name} code is foreign')
    return [values[code] for code in codes]


def _rows(rows, fields):
    """Columnar-encode an evidence table, carrying unknown fields verbatim."""
    if not rows:
        return None
    columns = [_encode_column([row.get(name) for row in rows]) for name in fields]
    extra_rows = [{k: v for k, v in row.items() if k not in fields} for row in rows]
    encoded_extras = None
    if any(extra_rows):
        # Unknown/per-read fields repeat across rows too (pid, entrySequence).
        # A uniform key set is factored KEY-BY-KEY so each field gets its own
        # dictionary column and a new field survives the wire without paying once
        # per row. A non-uniform set falls back to whole-row dictionaries.
        keys = sorted({key for row in extra_rows for key in row})
        uniform = len(keys) > 0 and all(sorted(row) == keys for row in extra_rows)
        if uniform:
            encoded_extras = {
                'form': 'fields', 'keys': keys,
                'columns': [_encode_column([row[key] for row in extra_rows]) for key in keys]}
        else:
            encoded_extras = _encode_column(extra_rows)
    return dict(layout=list(fields), columns=columns,
                extras=encoded_extras, count=len(rows))


def _unrows(encoded, fields, what):
    if encoded is None:
        return []
    if not isinstance(encoded.get('layout'), list) or list(encoded['layout']) != list(fields):
        raise ValueError(f'generated producer transport {what} layout differs')
    columns = encoded.get('columns')
    if not isinstance(columns, list) or len(columns) != len(fields):
        raise ValueError(f'generated producer transport {what} columns required')
    count = encoded.get('count')
    if not isinstance(count, int) or count < 0:
        raise ValueError(f'generated producer transport {what} count differs')
    decoded = []
    for i, name in enumerate(fields):
        column = columns[i]
        if isinstance(column, list):
            # v1 form: the column IS the per-row values.
            if len(column) != count:
                raise ValueError(f'generated producer transport {what} column length differs')
            decoded.append(list(column))
        else:
            decoded.append(_decode_column(column, count, what, name))
    extras = encoded.get('extras')
    if extras is None:
        decoded_extras = [None] * count
    elif isinstance(extras, list):
        # v1 form: the extras list IS the per-row value.
        if len(extras) != count:
            raise ValueError(f'generated producer transport {what} extras length differs')
        decoded_extras = list(extras)
    elif isinstance(extras, dict) and extras.get('form') == 'fields':
        keys = extras.get('keys')
        columns = extras.get('columns')
        if not isinstance(keys, list) or not all(isinstance(key, str) for key in keys) \
                or not isinstance(columns, list) or len(columns) != len(keys):
            raise ValueError(f'generated producer transport {what} extras keys differ')
        decoded_columns = []
        for i, key in enumerate(keys):
            column = columns[i]
            decoded_columns.append(
                list(column) if isinstance(column, list)
                else _decode_column(column, count, what, 'extras.' + key))
        decoded_extras = [{key: decoded_columns[i][position] for i, key in enumerate(keys)}
                          for position in range(count)]
    else:
        decoded_extras = _decode_column(extras, count, what, 'extras')
    out = []
    for position in range(count):
        row = dict(decoded_extras[position] or {})
        row.update({name: decoded[i][position] for i, name in enumerate(fields)})
        out.append(row)
    return out


def _split_unknown(row, known):
    return {key: value for key, value in row.items() if key not in known}


def encode(inputs, witnesses, graph=None, custody=None, source_class=None):
    """Expand the derived projections into the versioned closed transport."""
    sources = []
    source_ids = {}
    reads = []
    read_extras = []
    input_extras = []
    read_ids = []

    for row in inputs:
        read = row.get('regularRead') or {}
        generation = read.get('generation')
        source_key = json.dumps([row['identity'], row['bytes'], row['sha256'],
                                 row.get('resolvedPath'), generation],
                                sort_keys=True, separators=(',', ':'), default=list)
        source_id = source_ids.get(source_key)
        if source_id is None:
            source_id = len(sources)
            source_ids[source_key] = source_id
            # A SOURCE row is stored ONCE for every read of that byte image. A
            # top-level unknown field therefore CANNOT live here: two reads of the
            # same source may carry different values, and the first would win.
            # All unknown top-level input fields travel on the READ extras.
            source_row = dict(
                sourceId=source_id,
                identity=row['identity'], bytes=row['bytes'], sha256=row['sha256'],
                generation=generation,
                extra={})
            # Key PRESENCE is part of the fact: a mapping input never carried a
            # resolvedPath, so the round trip must not invent one.
            if 'resolvedPath' in row:
                source_row['resolvedPath'] = row['resolvedPath']
            sources.append(source_row)
        read_ids.append(len(reads))
        reads.append({
            'sourceId': source_id,
            'entrySequence': row['entrySequence'], 'captureSequence': row['captureSequence'],
            'inputModel': row['inputModel'], 'lifetimeLeaseSequence': row.get('lifetimeLeaseSequence'),
            'protection': row.get('protection'), 'flags': row.get('flags'),
            'executable': row.get('executable'),
            'form': read.get('form'), 'fd': read.get('fd'),
            'readLeaseSequence': read.get('readLeaseSequence'),
            'rangeStart': read.get('rangeStart'), 'consumedLength': read.get('consumedLength'),
            'result': read.get('result'), 'exitSequence': read.get('exitSequence'),
            'iovcnt': read.get('iovcnt'), 'iovLengths': read.get('iovLengths')})
        # PER-READ extras: anything unknown inside `regularRead` PLUS any
        # unknown top-level input field. Two reads of the SAME source may carry
        # DIFFERENT top-level extras; keeping them here is what makes that
        # lossless instead of collapsing to the first read's value.
        # TWO SEPARATE SLOTS, no magic key and no reserved spelling:
        #  * `readExtras`   keeps its LEGACY meaning -- unknowns of `regularRead`
        #    (exactly what a v2 reader already expects);
        #  * `inputExtras`  is a NEW optional slot for unknown TOP-LEVEL input
        #    fields of that one read.
        # Because they are separate lists, an unknown field may be named anything
        # at all -- including a name that collides between the two scopes -- and
        # both survive independently.
        read_extras.append(_split_unknown(read, set(READ_FIELDS) | {'generation'}))
        input_extras.append(_split_unknown(row, set(SOURCE_FIELDS) | set(READ_SCOPED_INPUT_FIELDS)))

    outputs = []
    for witness in witnesses:
        outputs.append(dict(
            path=witness['path'], bytes=witness['bytes'], sha256=witness['sha256'],
            identity=witness['identity'],
            completedCloseSequence=witness['completedCloseSequence'],
            producerCaptureSequence=witness['producerCaptureSequence'],
            producerPid=witness.get('producerPid'), phase=witness.get('phase'),
            execImage=witness.get('execImage'),
            inputComplete=witness.get('inputComplete'),
            readOperations=witness.get('readOperations'),
            inputObligationCount=witness.get('inputObligationCount'),
            mappingInputCount=witness.get('mappingInputCount'),
            readInputCount=witness.get('readInputCount'),
            unexplainedReads=witness.get('unexplainedReads') or [],
            inputIds=list(witness.get('inputIds') or []),
            extra=_split_unknown(witness, set(OUTPUT_FIELDS) | {'inputIds'})))

    # GRAPH EDGE COMPACTION. A graph edge repeats 9 fields that are ALREADY
    # carried, once, by its read row: entrySequence, captureSequence, inputModel,
    # lifetimeLeaseSequence, form, fd, rangeStart, consumedLength, result,
    # exitSequence. The edge therefore only needs (inputNodeId, readId); the
    # consumer re-expands the full 11-field edge from the read table before any
    # validation, so missing/extra/future/self-edge checks are unchanged.
    compact_graph = graph
    if isinstance(graph, dict):
        index = {}
        for row in inputs:
            read = row.get('regularRead') or {}
            index[(row['inputModel'], row['entrySequence'], row['captureSequence'])] = row['inputId']
        sets = []
        for entry in graph.get('inputSets') or []:
            ids = []
            for edge in entry.get('edges') or []:
                read_id = index.get((edge[3], edge[1], edge[2]))
                if read_id is None:
                    raise ValueError('generated producer transport graph edge has no read row')
                ids.append(read_id)
            sets.append(dict(setId=entry['setId'], readIds=ids))
        compact_graph = dict(graph, model='compact-deduplicated-causal-graph-v2',
                             edgeLayout=['inputNodeId', 'readId'], inputSets=sets)

    # The read table repeats its source/lease/ABI values 24k times in the real
    # shape, so it gets the SAME dictionary treatment as the evidence tables.
    columns = [_encode_column([row.get(name) for row in reads]) for name in READ_FIELDS]
    # Empty extras are the overwhelmingly common case: omit them entirely and
    # let the decoder treat a missing list as all-empty, so the wire does not pay
    # one `{}` per read.
    extras = read_extras if any(read_extras) else None
    # OPTIONAL: omitted entirely when no read carries a top-level unknown, so the
    # wire does not pay for a feature nobody used and old readers still work.
    top_extras = input_extras if any(input_extras) else None
    return dict(schemaVersion=2, model=MODEL,
                sourceLayout=list(SOURCE_FIELDS), readLayout=list(READ_FIELDS),
                sourceCount=len(sources), readCount=len(reads), outputCount=len(outputs),
                sources=sources, readColumns=columns, readExtras=extras,
                inputExtras=top_extras, outputs=outputs,
                graph=compact_graph,
                custody=_rows(custody, CUSTODY_FIELDS),
                sourceClass=_rows(source_class, SOURCECLASS_FIELDS),
                scope='derived transport of the same validated replay; no second authority')


def decode(transport):
    """Rebuild the exact per-output input lists the verifier expects.

    Raises ValueError on any structural damage. Never silently narrows: a
    missing/duplicate/foreign id is refused.
    """
    if not isinstance(transport, dict) or transport.get('model') != MODEL:
        raise ValueError('generated producer transport model differs')
    if transport.get('schemaVersion') != 2:
        raise ValueError('generated producer transport schema version differs')
    sources = transport.get('sources')
    outputs = transport.get('outputs')
    if not isinstance(sources, list) or not isinstance(outputs, list):
        raise ValueError('generated producer transport arrays required')
    read_count = transport.get('readCount')
    if not isinstance(read_count, int) or read_count < 0:
        raise ValueError('generated producer transport read count differs')
    if transport.get('sourceCount') != len(sources):
        raise ValueError('generated producer transport source count differs')
    if transport.get('outputCount') != len(outputs):
        raise ValueError('generated producer transport output count differs')

    by_source = {}
    for index, source in enumerate(sources):
        if not isinstance(source, dict) or source.get('sourceId') != index:
            raise ValueError('generated producer transport source id differs')
        if index in by_source:
            raise ValueError('generated producer transport duplicate source id')
        by_source[index] = source

    # Reads are columnar: one array per field, position = readId. This is what
    # removes the repeated field NAMES; every VALUE is still carried.
    layout = transport.get('readLayout')
    if not isinstance(layout, list) or list(layout) != list(READ_FIELDS):
        raise ValueError('generated producer transport read layout differs')
    columns = transport.get('readColumns')
    if not isinstance(columns, list) or len(columns) != len(READ_FIELDS):
        raise ValueError('generated producer transport read columns required')
    read_values = []
    for index, column in enumerate(columns):
        if isinstance(column, list):
            # v1 form: the column IS the per-read values.
            if len(column) != read_count:
                raise ValueError('generated producer transport read column length differs')
            read_values.append(list(column))
        else:
            read_values.append(_decode_column(column, read_count, 'read', READ_FIELDS[index]))
    reads = [{name: read_values[i][position] for i, name in enumerate(READ_FIELDS)}
             for position in range(read_count)]

    by_read = {}
    for index, read in enumerate(reads):
        if not isinstance(read.get('sourceId'), int) or read['sourceId'] not in by_source:
            raise ValueError('generated producer transport read cites a foreign source')
        by_read[index] = read

    extras = transport.get('readExtras')
    if extras is None:
        extras = [None] * len(reads)
    elif isinstance(extras, list):
        if len(extras) != len(reads):
            raise ValueError('generated producer transport read extras length differs')
    else:
        extras = _decode_column(extras, len(reads), 'read', 'extras')
    # OPTIONAL top-level per-read unknowns. Absent -> every read has none, which
    # is what a v2 transport WITHOUT the feature means. A DIFFERENT meaning is
    # never inferred from the same bytes.
    top_extras = transport.get('inputExtras')
    if top_extras is None:
        top_extras = [None] * len(reads)
    elif isinstance(top_extras, list):
        if len(top_extras) != len(reads):
            raise ValueError('generated producer transport input extras length differs')
    else:
        top_extras = _decode_column(top_extras, len(reads), 'input', 'extras')

    graph_nodes = [n for n in (transport.get('graph') or {}).get('nodes') or []]
    # Index the input nodes once (identity+bytes+sha+model is unique per node) so
    # re-expansion stays O(edges); a miss is still refused, never guessed.
    node_by_key = {}
    for node in graph_nodes:
        if node.get('model') == 'output':
            continue
        key = (node.get('model'), str(node.get('bytes')), node.get('sha256'),
               tuple(str(v) for v in node.get('identity') or []))
        if key in node_by_key and node_by_key[key] != node['nodeId']:
            raise ValueError('generated producer transport ambiguous input node')
        node_by_key[key] = node['nodeId']

    def entryReadNode(read):
        """Resolve the input node id for one read from the carried nodes."""
        source = by_source[read['sourceId']]
        key = (read['inputModel'], str(source['bytes']), source['sha256'],
               tuple(str(v) for v in source['identity']))
        node_id = node_by_key.get(key)
        if node_id is None:
            raise ValueError('generated producer transport graph read has no node')
        return node_id

    inputs = []
    for read_index, read in enumerate(reads):
        source = by_source[read['sourceId']]
        generation = source.get('generation')
        row = dict(source.get('extra') or {})
        # `readExtras` are the nested `regularRead` unknowns (legacy meaning) and
        # `inputExtras` the top-level ones. Two independent slots means a field
        # name colliding between the scopes cannot steal either value.
        nested = dict(extras[read_index] or {})
        row.update(top_extras[read_index] or {})
        row.update(
            inputId=read_index,
            entrySequence=read['entrySequence'], captureSequence=read['captureSequence'],
            identity=source['identity'], bytes=source['bytes'], sha256=source['sha256'],
            protection=read.get('protection'), flags=read.get('flags'),
            lifetimeLeaseSequence=read.get('lifetimeLeaseSequence'),
            executable=read.get('executable'), inputModel=read['inputModel'],
            graphKey=_graph_key(read['inputModel'], read['captureSequence']))
        if 'resolvedPath' in source:
            row['resolvedPath'] = source['resolvedPath']
        if read.get('form') is not None:
            regular = dict(nested)
            regular.update(form=read.get('form'), fd=read.get('fd'),
                           readLeaseSequence=read.get('readLeaseSequence'),
                           rangeStart=read.get('rangeStart'),
                           consumedLength=read.get('consumedLength'),
                           result=read.get('result'), exitSequence=read.get('exitSequence'),
                           generation=generation,
                           iovcnt=read.get('iovcnt'), iovLengths=read.get('iovLengths'))
            row['regularRead'] = regular
        elif nested:
            raise ValueError('generated producer transport read carries unknown non-read fields')
        inputs.append(row)

    # Re-expand the compact graph into the full 11-field edge layout the verifier
    # validates. Every non-id field comes from its own read row, so the graph can
    # never disagree with the read table.
    graph = transport.get('graph')
    if isinstance(graph, dict) and graph.get('model') == 'compact-deduplicated-causal-graph-v2':
        expanded = []
        for entry in graph.get('inputSets') or []:
            edges = []
            for read_id in entry.get('readIds') or []:
                if not isinstance(read_id, int) or read_id not in by_read:
                    raise ValueError('generated producer transport graph cites a foreign read')
                read = by_read[read_id]
                edges.append([entryReadNode(read), read['entrySequence'], read['captureSequence'],
                              read['inputModel'], read.get('lifetimeLeaseSequence'),
                              read.get('form'), read.get('fd'), read.get('rangeStart'),
                              read.get('consumedLength'), read.get('result'),
                              read.get('exitSequence')])
            expanded.append(dict(setId=entry['setId'], edges=edges))
        graph = dict(graph, model='compact-deduplicated-causal-graph-v1',
                     edgeLayout=['inputNodeId', 'entrySequence', 'captureSequence', 'inputModel',
                                 'lifetimeLeaseSequence', 'readForm', 'readFd', 'readRangeStart',
                                 'readConsumedLength', 'readResult', 'readExitSequence'],
                     inputSets=expanded)

    witness = []
    for output in outputs:
        ids = output.get('inputIds')
        if not isinstance(ids, list):
            raise ValueError('generated producer transport output lacks input ids')
        resolved = []
        for read_id in ids:
            if not isinstance(read_id, int) or read_id not in by_read:
                raise ValueError('generated producer transport output cites a foreign read')
            resolved.append(inputs[read_id])
        row = dict(output.get('extra') or {})
        row.update(
            path=output['path'], bytes=output['bytes'], sha256=output['sha256'],
            identity=output['identity'],
            completedCloseSequence=output['completedCloseSequence'],
            producerCaptureSequence=output['producerCaptureSequence'],
            producerPid=output.get('producerPid'), phase=output.get('phase'),
            execImage=output.get('execImage'), inputComplete=output.get('inputComplete'),
            readOperations=output.get('readOperations'),
            inputObligationCount=output.get('inputObligationCount'),
            mappingInputCount=output.get('mappingInputCount'),
            readInputCount=output.get('readInputCount'),
            unexplainedReads=output.get('unexplainedReads') or [],
            inputIds=ids, inputs=resolved)
        witness.append(row)
    return (inputs, witness, graph,
            _unrows(transport.get('custody'), CUSTODY_FIELDS, 'custody'),
            _unrows(transport.get('sourceClass'), SOURCECLASS_FIELDS, 'sourceClass'))


def assert_lossless(before_inputs, before_witness, after_inputs, after_witness, before_graph=None, after_graph=None):
    """Round-trip proof helper for tests: every carried fact must be identical."""
    def normalise(row):
        value = dict(row)
        value.pop('inputId', None)
        value['graphKey'] = list(value.get('graphKey') or [])
        return json.loads(json.dumps(value, sort_keys=True, default=list))
    if [normalise(r) for r in before_inputs] != [normalise(r) for r in after_inputs]:
        raise AssertionError('input records changed across transport')
    left = [{k: v for k, v in w.items() if k != 'inputs'} for w in before_witness]
    right = [{k: v for k, v in w.items() if k != 'inputs'} for w in after_witness]
    if json.dumps(left, sort_keys=True, default=list) != json.dumps(right, sort_keys=True, default=list):
        raise AssertionError('witness rows changed across transport')
    # The decoded rows must resolve to the SAME input records, in the same order.
    for before, after in zip(before_witness, after_witness):
        expected = sorted(before.get('inputIds') or [])
        actual = sorted(row['inputId'] for row in after['inputs'])
        if expected != actual:
            raise AssertionError('per-output input membership changed across transport')
        # and the RESOLVED records must be the same objects, value for value
        before_rows = sorted((before_inputs[i] for i in before.get('inputIds') or []), key=lambda r: r['inputId'])
        after_rows = sorted(after['inputs'], key=lambda r: r['inputId'])
        if [normalise(r) for r in before_rows] != [normalise(r) for r in after_rows]:
            raise AssertionError('per-output resolved inputs changed across transport')


def assert_graph_lossless(before_graph, after_graph):
    """The re-expanded graph must equal the original edge for edge."""
    if before_graph is None and after_graph is None:
        return
    if not isinstance(before_graph, dict) or not isinstance(after_graph, dict):
        raise AssertionError('causal graph missing across transport')
    left = [[[int(e[0]), int(e[1]), int(e[2]), e[3], e[4], e[5], e[6], e[7], e[8], e[9], e[10]]
             for e in s['edges']] for s in before_graph['inputSets']]
    right = [[[int(e[0]), int(e[1]), int(e[2]), e[3], e[4], e[5], e[6], e[7], e[8], e[9], e[10]]
              for e in s['edges']] for s in after_graph['inputSets']]
    if json.dumps(left, sort_keys=True, default=list) != json.dumps(right, sort_keys=True, default=list):
        raise AssertionError('causal graph changed across transport')
    if before_graph.get('nodeCount') != after_graph.get('nodeCount'):
        raise AssertionError('causal graph node count changed across transport')
    if before_graph.get('edgeCount') != after_graph.get('edgeCount'):
        raise AssertionError('causal graph edge count changed across transport')
