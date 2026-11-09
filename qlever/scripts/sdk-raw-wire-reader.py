"""Bounded reader for the lossless kernel-raw-gzip-v1 wire container.

The reader consumes independently verified archive blocks, verifies the single
gzip member and both byte identities, and yields the exact original rows.  It
never trusts a caller-supplied boolean as authority: the reference mapping is
validated structurally and compared byte for byte.
"""
import hashlib
import zlib

MODEL = 'kernel-raw-gzip-v1'
CHUNK = 65536


class RawWireError(ValueError):
    """The encoded or logical raw wire stream is invalid."""


def _nonnegative(name, value):
    if type(value) is not int or value < 0:
        raise RawWireError(name + ' must be a nonnegative integer')
    return value


def _positive(name, value):
    if type(value) is not int or value < 1:
        raise RawWireError(name + ' must be a positive integer')
    return value


def _digest(value):
    if type(value) is not str or len(value) != 64:
        raise RawWireError('reference SHA256 must be 64 lowercase hex digits')
    if any(character not in '0123456789abcdef' for character in value):
        raise RawWireError('reference SHA256 must be 64 lowercase hex digits')
    return value


def _reference(value, maximum_encoded, maximum_logical):
    if type(value) is not dict:
        raise RawWireError('raw wire reference must be the writer mapping')
    if set(value) != {'model', 'encoded', 'logical'}:
        raise RawWireError('raw wire reference has an unexpected shape')
    if value['model'] != MODEL:
        raise RawWireError('raw wire reference model changed')
    result = {}
    for name in ('encoded', 'logical'):
        part = value[name]
        if type(part) is not dict or set(part) != {'bytes', 'sha256'}:
            raise RawWireError('raw wire ' + name + ' identity is malformed')
        count = _nonnegative(name + '.bytes', part['bytes'])
        digest = _digest(part['sha256'])
        result[name] = (count, digest)
    if result['encoded'][0] > maximum_encoded:
        raise RawWireError('reference encoded byte bound exceeded')
    if result['logical'][0] > maximum_logical:
        raise RawWireError('reference logical byte bound exceeded')
    return result


def iter_records(blocks, reference, *, check, maximum_encoded,
                 maximum_logical, maximum_record=65536):
    """Yield exact rows from one gzip member, verifying it on exhaustion."""
    if not callable(check):
        raise RawWireError('check callback is required')
    maximum_encoded = _nonnegative('maximum_encoded', maximum_encoded)
    maximum_logical = _nonnegative('maximum_logical', maximum_logical)
    maximum_record = _positive('maximum_record', maximum_record)
    identities = _reference(reference, maximum_encoded, maximum_logical)
    reference_encoded = identities['encoded']
    reference_logical = identities['logical']

    def records():
        encoded = hashlib.sha256()
        logical = hashlib.sha256()
        encoded_bytes = 0
        logical_bytes = 0
        record_count = 0
        pending = bytearray()
        inflater = zlib.decompressobj(31)
        eof = False

        def fail(reason):
            raise RawWireError(reason)

        check()
        exhausted = False
        for block in blocks:
            check()
            exhausted = True
            if type(block) is not bytes:
                fail('raw wire encoded block must be bytes')
            if len(block) > CHUNK:
                fail('raw wire encoded block exceeds 65536 bytes')
            if eof and block:
                fail('extra data or second gzip member after the member')
            encoded_bytes += len(block)
            if encoded_bytes > maximum_encoded:
                fail('encoded raw wire byte bound exceeded')
            if encoded_bytes > reference_encoded[0]:
                fail('encoded raw wire byte count changed')
            encoded.update(block)
            if not block:
                continue

            data = block
            while True:
                check()
                before = data
                try:
                    output = inflater.decompress(data, CHUNK)
                except zlib.error as error:
                    raise RawWireError(
                        'gzip raw wire member is damaged') from error
                tail = inflater.unconsumed_tail
                if inflater.eof:
                    if inflater.unused_data or tail:
                        fail('extra data or second gzip member after the '
                             'member')
                    eof = True
                data = tail
                if output:
                    if logical_bytes + len(output) > maximum_logical:
                        fail('logical raw wire byte bound exceeded')
                    if logical_bytes + len(output) > reference_logical[0]:
                        fail('logical raw wire byte count changed')
                    logical.update(output)
                    logical_bytes += len(output)
                    # Fail before retaining a range that cannot be one row.
                    first = output.find(b'\n')
                    if first >= 0:
                        if len(pending) + first + 1 > maximum_record:
                            fail('raw wire record exceeds the record bound')
                    elif len(pending) + len(output) > maximum_record:
                        fail('raw wire record exceeds the record bound')
                    pending.extend(output)
                    while True:
                        end = pending.find(b'\n')
                        if end < 0:
                            break
                        record = bytes(pending[:end + 1])
                        del pending[:end + 1]
                        if len(record) <= 1:
                            fail('empty raw wire record')
                        if len(record) > maximum_record:
                            fail('raw wire record exceeds the record bound')
                        record_count += 1
                        check()
                        yield record
                    if len(pending) > maximum_record:
                        fail('raw wire record exceeds the record bound')
                    check()
                if eof:
                    if data:
                        fail('extra data after the gzip member')
                    break
                if data:
                    if tail == before and not output:
                        fail('gzip raw wire decompressor made no progress')
                    continue
                # max_length can stop with all input consumed while more
                # output remains inside zlib.  Drain it before the next block.
                if len(output) == CHUNK:
                    continue
                break

        check()
        if not exhausted:
            fail('empty raw wire encoded stream')
        if encoded_bytes == 0:
            fail('empty raw wire encoded stream')
        if not eof:
            fail('truncated gzip raw wire stream')
        if inflater.unused_data:
            fail('extra data or second gzip member after the member')
        if pending:
            fail('raw wire stream is missing its final LF')
        if record_count == 0 or logical_bytes == 0:
            fail('empty raw wire logical stream')
        if encoded_bytes != reference_encoded[0]:
            fail('encoded raw wire byte count changed')
        if encoded.hexdigest() != reference_encoded[1]:
            fail('encoded raw wire SHA256 changed')
        if logical_bytes != reference_logical[0]:
            fail('logical raw wire byte count changed')
        if logical.hexdigest() != reference_logical[1]:
            fail('logical raw wire SHA256 changed')

    return records()


def iter_shard_records(blocks, reference, *, check, maximum_encoded, maximum_logical, maximum_record=65536):
    """Exhaust to verify the complete physical original and logical wire."""
    if 'wire' in reference:
        wire=reference['wire']
        if not isinstance(wire,dict) or wire.get('encoded')!={'bytes':reference.get('bytes'),'sha256':reference.get('sha256')}:
            raise RawWireError('outer raw original differs from encoded wire')
        yield from iter_records(blocks,wire,check=check,maximum_encoded=maximum_encoded,maximum_logical=maximum_logical,maximum_record=maximum_record)
        return
    count=0;digest=hashlib.sha256();pending=bytearray()
    for block in blocks:
        check()
        if not isinstance(block,bytes) or len(block)>65536:raise RawWireError('bounded raw block required')
        count+=len(block)
        if count>min(maximum_encoded,maximum_logical,reference['bytes']):raise RawWireError('raw shard bound')
        digest.update(block);pending.extend(block)
        while b'\n' in pending:
            end=pending.index(b'\n')+1
            if end>maximum_record:raise RawWireError('raw record bound')
            row=bytes(pending[:end]);del pending[:end];check();yield row
        if len(pending)>maximum_record:raise RawWireError('unfinished raw record bound')
    check()
    if pending or count!=reference['bytes'] or digest.hexdigest()!=reference['sha256']:raise RawWireError('whole raw shard identity or final LF differs')
