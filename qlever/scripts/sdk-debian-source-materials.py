"""Exact Debian source-set mechanics; no official-origin or SDK capability.

The producer owns apt supervision and signed Sources/InRelease originals. This
helper only parses those declared source identities and retains/checks bytes.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

METADATA_BYTES = 4 * 1024**2
PACKAGE = re.compile(r'[a-z0-9][a-z0-9+.-]*\Z')
VERSION = re.compile(r'(?:[0-9]+:)?[0-9][A-Za-z0-9.+:~\-]*\Z')
FILENAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9.+~_\-]*\Z')


def require(value, reason):
    if not value:
        raise ValueError('SDK Debian source originals: ' + reason)


def source_identity(name, version):
    require(isinstance(name, str) and PACKAGE.fullmatch(name), 'canonical source package required')
    require(isinstance(version, str) and VERSION.fullmatch(version), 'exact source version required')
    return dict(name=name, version=version)


def parse_source_ledger(data):
    require(len(data) <= METADATA_BYTES and b'\0' not in data, 'bounded dpkg source ledger required')
    result = {}
    for line in data.decode('utf-8').splitlines():
        fields = line.split('\t')
        require(len(fields) == 4, 'actual four-column dpkg source ledger required')
        binary, version, source, source_version = fields
        require(re.fullmatch(r'[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?', binary), 'invalid binary package identity')
        require(VERSION.fullmatch(version), 'exact binary package version required')
        identity = source_identity(source, source_version)
        require(binary not in result, 'duplicate binary package identity')
        result[binary] = dict(binaryVersion=version, source=identity)
    require(result, 'empty dpkg source ledger')
    return result


def required_sources(selected, ownership, ledger):
    """Map actual absolute input paths through captured .list files, not names guessed from headers."""
    packages = parse_source_ledger(ledger)
    selected = set(selected)
    require(selected and all(isinstance(name, str) and name.startswith('/') and '\\' not in name
            and not any(part in ('.', '..', '') for part in name.split('/')[1:]) for name in selected), 'canonical absolute selected inputs required')
    owners = {name: set() for name in selected}
    for binary, data in ownership.items():
        require(binary in packages and len(data) <= 16 * 1024**2, 'bounded known ownership original required')
        for name in set(data.decode('utf-8').splitlines()) & selected:
            owners[name].add(binary)
    identities = {}
    for names in owners.values():
        for binary in names:
            identity = packages[binary]['source']
            identities[(identity['name'], identity['version'])] = identity
    return dict(packages=sorted(identities.values(), key=lambda row: (row['name'], row['version'])),
                inputOwners=[dict(path=name, binaries=sorted(owners[name])) for name in sorted(selected)],
                unresolvedInputs=sorted(name for name in selected if not owners[name]))


def parse_dsc(data):
    require(0 < len(data) <= METADATA_BYTES and b'\0' not in data, 'bounded dsc original required')
    text = data.decode('utf-8')
    require('\r' not in text, 'canonical dsc line endings required')
    armored = text.startswith('-----BEGIN PGP SIGNED MESSAGE-----\n')
    if armored:
        header, separator, tail = text.partition('\n\n')
        require(separator and all(line.startswith('Hash: ') for line in header.splitlines()[1:]), 'clear-signature header malformed')
        body, separator, signature = tail.partition('\n-----BEGIN PGP SIGNATURE-----\n')
        require(separator and signature.rstrip().endswith('-----END PGP SIGNATURE-----'), 'clear-signature original incomplete')
        text = '\n'.join(line[2:] if line.startswith('- ') else line for line in body.split('\n'))
    fields = {}; current = None
    for line in text.rstrip('\n').split('\n'):
        require(line != '', 'multiple dsc stanzas forbidden')
        if line.startswith((' ', '\t')):
            require(current is not None, 'orphan dsc continuation')
            fields[current] += '\n' + line.lstrip(' \t')
        else:
            key, separator, value = line.partition(':')
            require(separator and re.fullmatch(r'[A-Za-z][A-Za-z0-9-]*', key) and key not in fields, 'duplicate or malformed dsc field')
            fields[key] = value.strip(); current = key
    identity = source_identity(fields.get('Source'), fields.get('Version'))
    format = fields.get('Format'); require(format in ('3.0 (quilt)', '3.0 (native)', '1.0'), 'unreviewed Debian source format')
    files = []
    for line in fields.get('Checksums-Sha256', '').strip().splitlines():
        values = line.split()
        require(len(values) == 3 and re.fullmatch(r'[a-f0-9]{64}', values[0]) and values[1].isdigit()
                and FILENAME.fullmatch(values[2]), 'canonical complete SHA256 file rows required')
        size = int(values[1]); require(size > 0, 'empty source archive unsupported')
        files.append(dict(name=values[2], bytes=size, sha256=values[0]))
    require(files and len(files) <= 4096 and len({row['name'] for row in files}) == len(files), 'duplicate or absent source archives')
    for key, length in [('Files', 32), ('Checksums-Sha1', 40)]:
        if key not in fields:
            continue
        rows = [line.split() for line in fields[key].strip().splitlines()]
        require(all(len(row) == 3 and re.fullmatch('[a-f0-9]{' + str(length) + '}', row[0]) and row[1].isdigit() for row in rows), 'malformed alternate source checksum rows')
        require(len(rows) == len(files) and {(row[2], int(row[1])) for row in rows} == {(row['name'], row['bytes']) for row in files}, 'source checksum universes differ')
    version = identity['version'].split(':', 1)[-1]; upstream = version.rsplit('-', 1)[0] if '-' in version else version
    prefix = re.escape(identity['name'] + '_'); compression = r'(?:gz|xz|bz2|lzma|zst)'
    names = {row['name'] for row in files}
    require(all(not name.endswith('.asc') or name[:-4] in names for name in names), 'orphan upstream source signature')
    if format == '3.0 (quilt)':
        main = re.compile(prefix + re.escape(upstream) + r'\.orig\.tar\.' + compression + r'\Z')
        orig = re.compile(prefix + re.escape(upstream) + r'\.orig(?:-[A-Za-z0-9][A-Za-z0-9+.-]*)?\.tar\.' + compression + r'(?:\.asc)?\Z')
        debian = re.compile(prefix + re.escape(version) + r'\.debian\.tar\.' + compression + r'\Z')
        require(any(main.fullmatch(name) for name in names) and sum(bool(debian.fullmatch(name)) for name in names) == 1
                and all(orig.fullmatch(name) or debian.fullmatch(name) for name in names), 'quilt main/orig components/debian archive closure differs')
    elif format == '3.0 (native)':
        require(len(names) == 1 and re.fullmatch(prefix + re.escape(version) + r'\.tar\.' + compression, next(iter(names))), 'native source archive closure differs')
    else:
        orig = identity['name'] + '_' + upstream + '.orig.tar.gz'; diff = identity['name'] + '_' + version + '.diff.gz'
        native = identity['name'] + '_' + version + '.tar.gz'
        require(names in ({orig, diff}, {native}), '1.0 source archive closure differs')
    return dict(schemaVersion=1, kind='mechanical-debian-source-description', **identity, format=format,
                dscSha256=hashlib.sha256(data).hexdigest(), clearSignedOriginalPresent=armored,
                files=sorted(files, key=lambda row: row['name']),
                pending=['signed-Debian-Sources-index-and-official-custody-not-verified-by-parser'])


def verify_source_directory(directory, name, version, maximum_bytes, *, check_budget):
    identity = source_identity(name, version)
    require(callable(check_budget), 'producer cumulative deadline observation required')
    check_budget()
    require(type(maximum_bytes) is int and maximum_bytes > 0, 'producer remaining byte budget required')
    root = Path(directory)
    signature = lambda row: (row.st_dev, row.st_ino, row.st_size, row.st_mtime_ns, row.st_ctime_ns, row.st_mode, row.st_nlink)
    initial = root.lstat()
    require(stat.S_ISDIR(initial.st_mode), 'ordinary source original directory required')
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    retained = []
    try:
        require(signature(os.fstat(root_fd)) == signature(initial), 'source directory changed before observation')
        dsc_name = name + '_' + version.split(':', 1)[-1] + '.dsc'
        require(FILENAME.fullmatch(dsc_name), 'canonical dsc filename required')
        def observe(filename, maximum):
            check_budget()
            fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root_fd)
            before = os.fstat(fd)
            retained.append((filename, fd, before))
            require(stat.S_ISREG(before.st_mode) and before.st_size <= maximum, 'bounded regular original required')
            digest = hashlib.sha256(); chunks = []
            for block in iter(lambda: os.read(fd, 65536), b''):
                check_budget()
                digest.update(block)
                if filename == dsc_name:
                    chunks.append(block)
            require(signature(before) == signature(os.fstat(fd)) == signature(os.stat(filename, dir_fd=root_fd, follow_symlinks=False)), 'source original changed during read')
            return dict(path=filename, bytes=before.st_size, sha256=digest.hexdigest()), b''.join(chunks)
        dsc, data = observe(dsc_name, min(METADATA_BYTES, maximum_bytes)); parsed = parse_dsc(data)
        require(parsed['name'] == identity['name'] and parsed['version'] == identity['version'], 'dsc exact source identity differs')
        expected = {row['name']: row for row in parsed['files']}
        expected_names = set(expected) | {dsc_name}
        require(set(os.listdir(root_fd)) == expected_names, 'source archive file universe differs')
        total = dsc['bytes']; originals = []
        for filename, row in sorted(expected.items()):
            actual, _ = observe(filename, maximum_bytes - total)
            require(actual['bytes'] == row['bytes'] and actual['sha256'] == row['sha256'], 'source archive exact bytes differ:' + filename)
            originals.append(actual); total += actual['bytes']
        check_budget()
        require(set(os.listdir(root_fd)) == expected_names, 'source archive file universe changed after observation')
        for filename, fd, before in retained:
            require(signature(before) == signature(os.fstat(fd)) == signature(os.stat(filename, dir_fd=root_fd, follow_symlinks=False)), 'previously read source original changed')
        require(signature(initial) == signature(os.fstat(root_fd)) == signature(root.lstat()), 'source original root directory changed')
        return dict(schemaVersion=1, kind='mechanical-debian-source-original-set', **identity,
                    dsc=dsc, files=originals, totalBytes=total, pending=parsed['pending'])
    finally:
        for _, fd, _ in retained:
            os.close(fd)
        os.close(root_fd)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--parse-dsc', action='store_true'); args = parser.parse_args()
    require(args.parse_dsc, 'fixed parse mode required')
    data = sys.stdin.buffer.read(METADATA_BYTES + 1)
    print(json.dumps(parse_dsc(data), separators=(',', ':')))
