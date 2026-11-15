"""Streaming Release/Sources checksum mechanics, NOT OpenPGP/keyring authority.

The receiver must separately bind these exact InRelease bytes to its actual
gpgv execution originals and independently accepted keyring. No filename,
caller boolean, signature-shaped armor, or returned JSON provides that trust.
"""
import bz2
import hashlib
import json
import lzma
from pathlib import Path
import re
import zlib

LIMITS = json.loads((Path(__file__).resolve().parents[2] / 'scripts/lib/module-artifact-limits.json').read_text())
CHUNK = LIMITS['rangeBytes']
META = LIMITS['metadataBytes']


def need(value, reason):
    if not value:
        raise ValueError('Debian index checksum mechanics: ' + reason)


def safe(name):
    return (isinstance(name, str) and bool(name) and not name.startswith('/') and '\\' not in name
            and not any(ord(c) < 32 or ord(c) == 127 for c in name)
            and all(part not in ('', '.', '..') for part in name.split('/')))


def stanza(lines):
    fields = {}; current = None
    for raw in lines:
        line = raw.decode('utf-8', errors='strict')
        need('\r' not in line and '\0' not in line, 'canonical Deb822 line encoding required')
        if line.startswith((' ', '\t')):
            need(current is not None, 'orphan Deb822 continuation')
            fields[current] += '\n' + line.lstrip(' \t')
        else:
            key, separator, value = line.partition(':'); key = key.lower()
            need(separator and re.fullmatch(r'[a-z][a-z0-9-]*', key) and key not in fields, 'duplicate/malformed Deb822 field')
            fields[key] = value.strip(); current = key
    return fields


def checksum_rows(text):
    result = {}
    for line in text.strip().splitlines():
        parts = line.split()
        need(len(parts) == 3 and re.fullmatch('[a-f0-9]{64}', parts[0]) and parts[1].isdigit()
             and safe(parts[2]) and parts[2] not in result, 'complete unique SHA256 rows required')
        result[parts[2]] = dict(bytes=int(parts[1]), sha256=parts[0])
        need(len(result) <= LIMITS['sourceMembers'], 'checksum row count bound')
    need(result, 'SHA256 stanza unavailable')
    return result


def release_checksums(inrelease):
    need(0 < len(inrelease) <= META and b'\0' not in inrelease and b'\r' not in inrelease, 'bounded canonical InRelease original required')
    need(inrelease.startswith(b'-----BEGIN PGP SIGNED MESSAGE-----\n'), 'actual clear-signed InRelease format required')
    header, separator, remainder = inrelease.partition(b'\n\n')
    need(separator and header.splitlines()[1:] and all(line.startswith(b'Hash: ') for line in header.splitlines()[1:]), 'InRelease armor header malformed')
    body, separator, signature = remainder.partition(b'\n-----BEGIN PGP SIGNATURE-----\n')
    need(separator and signature.rstrip().endswith(b'-----END PGP SIGNATURE-----'), 'InRelease signature original incomplete')
    lines = [line[2:] if line.startswith(b'- ') else line for line in body.split(b'\n')]
    need(all(lines), 'exactly one Release stanza required')
    need(len(lines) <= LIMITS['sourceMembers'], 'Release line count bound')
    return checksum_rows(stanza(lines).get('sha256', ''))


def verify_sources_checksum_link(inrelease, chunks, packages, *, check_budget, maximum_uncompressed=None, require_all_packages=True):
    """chunks are original apt-list bytes in <=64KiB blocks, not whole buffers.

    Apt may recompress lists locally. Accept a signed compressed entry only if
    its ACTUAL codec/size/full digest match, otherwise require the signed plain
    Sources digest after complete bounded decoding. Apt .lz4 needs a separately
    retained actual decoded original; never treat it as signed Sources.xz.
    """
    signed = release_checksums(inrelease)
    maximum = LIMITS['sourceBytes'] if maximum_uncompressed is None else maximum_uncompressed
    need(isinstance(maximum, int) and 0 < maximum <= LIMITS['sourceBytes'], 'fixed expanded index bound')
    need(isinstance(packages, list) and 0 < len(packages) <= 4096, 'bounded exact source coordinates required')
    requested = {}; requested_files = 0
    for item in packages:
        key = (item['name'], item['version'])
        need(key not in requested and isinstance(key[0], str) and isinstance(key[1], str), 'unique exact source tuple required')
        need(isinstance(item.get('files'), list) and len(item['files']) <= 4096, 'source original count bound')
        requested_files += len(item['files']) + 1; need(requested_files <= LIMITS['sourceMembers'], 'aggregate source original count bound')
        originals = {}
        for row in [item['dsc'], *item['files']]:
            need(safe(row['path']) and isinstance(row['bytes'], int) and row['bytes'] > 0 and re.fullmatch('[a-f0-9]{64}', row['sha256']), 'exact original source file identity required')
            basename = row['path'].rsplit('/', 1)[-1]
            need(basename not in originals, 'duplicate original source basename')
            originals[basename] = dict(bytes=row['bytes'], sha256=row['sha256'])
        requested[key] = originals
    found = {}; line_buffer = b''; lines = []; stanza_bytes = 0; source_stanzas = 0
    raw_hash = hashlib.sha256(); plain_hash = hashlib.sha256(); raw_size = plain_size = 0
    def finish_stanza():
        nonlocal lines, stanza_bytes, source_stanzas
        if not lines:
            return
        source_stanzas += 1; need(source_stanzas <= LIMITS['sourceMembers'], 'Sources record count bound')
        fields = stanza(lines); key = (fields.get('package'), fields.get('version'))
        need(all(isinstance(part, str) and part for part in key), 'Sources package/version unavailable')
        if key in requested:
            need(key not in found and safe(fields.get('directory')), 'duplicate exact source record or invalid Directory')
            rows = checksum_rows(fields.get('checksums-sha256', ''))
            need(rows == requested[key], 'Sources dsc/all orig-debian checksum universe differs')
            found[key] = dict(name=key[0], version=key[1], directory=fields['directory'])
        lines = []; stanza_bytes = 0
    def consume(block):
        nonlocal line_buffer, plain_size, stanza_bytes
        check_budget(); plain_size += len(block)
        need(len(block) <= CHUNK and plain_size <= maximum, 'expanded Sources bound exceeded')
        plain_hash.update(block); parts = (line_buffer + block).split(b'\n'); line_buffer = parts.pop()
        for line in parts:
            if line:
                stanza_bytes += len(line) + 1; need(stanza_bytes <= META, 'Sources stanza bound exceeded'); lines.append(line)
            else:
                finish_stanza()
        need(len(line_buffer) <= META, 'Sources line bound exceeded')
    iterator = iter(chunks); prefix = b''
    def raw_block(block):
        nonlocal raw_size
        check_budget(); need(isinstance(block, bytes) and 0 < len(block) <= CHUNK, 'bounded nonempty original index chunk required')
        raw_size += len(block); need(raw_size <= LIMITS['shardBytes'], 'packed index original bound exceeded'); raw_hash.update(block)
    while len(prefix) < 6:
        try:
            block = next(iterator)
        except StopIteration:
            break
        raw_block(block); prefix += block
    need(prefix or not require_all_packages, 'empty Sources original')
    if prefix.startswith(b'\x1f\x8b'):
        codec, decoder = 'gz', zlib.decompressobj(16 + zlib.MAX_WBITS)
    elif prefix.startswith(b'\xfd7zXZ\x00'):
        codec, decoder = 'xz', lzma.LZMADecompressor(format=lzma.FORMAT_XZ, memlimit=64 * 1024**2)
    elif prefix.startswith(b'BZh'):
        codec, decoder = 'bz2', bz2.BZ2Decompressor()
    elif prefix.startswith((b'\x04\x22\x4d\x18', b'\x28\xb5\x2f\xfd')):
        raise ValueError('Debian index checksum mechanics: actual apt lz4/zstd list requires retained decoded Sources original')
    else:
        codec, decoder = '', None
    def decode(block):
        if decoder is None:
            for at in range(0, len(block), CHUNK): consume(block[at:at + CHUNK])
            return
        need(not decoder.eof, 'trailing/concatenated compressed index member')
        while True:
            consume(decoder.decompress(block, CHUNK)); block = decoder.unconsumed_tail if codec == 'gz' else b''
            need(not decoder.unused_data, 'trailing/concatenated compressed index bytes')
            if decoder.eof or (not block if codec == 'gz' else decoder.needs_input): break
    decode(prefix)
    for block in iterator:
        raw_block(block); decode(block)
    need(decoder is None or decoder.eof, 'truncated compressed index original')
    need(not line_buffer, 'Sources must end with a complete line'); finish_stanza()
    if require_all_packages:
        need(len(found) == len(requested), 'exact source name/version missing from Sources')
    check_budget()
    suffix = '.' + codec if codec else ''
    raw_identity = dict(bytes=raw_size, sha256=raw_hash.hexdigest()); plain_identity = dict(bytes=plain_size, sha256=plain_hash.hexdigest())
    matches = []
    for name, identity in signed.items():
        if name.endswith('/source/Sources' + suffix) and identity == raw_identity:
            matches.append((name[:-len(suffix)] if suffix else name, name, 'original-compressed' if codec else 'plain'))
        if name.endswith('/source/Sources') and identity == plain_identity:
            matches.append((name, name, 'decoded-plain'))
    need(matches and len({row[0] for row in matches}) == 1, 'actual Sources bytes do not uniquely bind signed InRelease SHA256')
    return dict(scope='checksum-mechanics-only-not-OpenPGP-or-keyring-authority',
                inReleaseSha256=hashlib.sha256(inrelease).hexdigest(), codec=codec or 'plain',
                original=raw_identity, decoded=plain_identity, signedIndexMatches=[dict(path=row[1], form=row[2]) for row in matches],
                packages=list(found.values()))
