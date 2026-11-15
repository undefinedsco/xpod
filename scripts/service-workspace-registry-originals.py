"""Retain canonical build-input transport originals in the caller's ledger.

No capability or build-use claim is issued here. The receiver independently
checks the immutable Git lock SRI, complete archive and manifest. Online legal
owner limits are unrelated and unchanged; this producer uses the existing
module source/shard bounds and a caller-owned retained-byte ledger.
"""
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import urllib.parse
import urllib.request

HERE = Path(__file__).resolve().parent
LIMITS = json.loads((HERE / 'lib/module-artifact-limits.json').read_bytes())
METADATA = json.loads((HERE / 'lib/registry-legal-original-limits.json').read_bytes())['metadataBytes']


def need(value, reason):
    if not value:
        raise ValueError('Service registry capture: ' + reason)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Service registry capture: redirect refused')


def file_identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)


def read_closed_original(file, reference, identity, check):
    check()
    named = os.lstat(file)
    need(file_identity(named) == identity and stat.S_ISREG(named.st_mode) and
         named.st_nlink == 1 and named.st_size == reference['bytes'] <= METADATA,
         'same bounded closed metadata identity')
    fd = os.open(file, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        need(file_identity(os.fstat(fd)) == identity, 'same held metadata descriptor')
        chunks, count, digest = [], 0, hashlib.sha256()
        while True:
            check()
            block = os.read(fd, min(LIMITS['rangeBytes'], reference['bytes'] + 1 - count))
            check()
            if not block:
                break
            count += len(block)
            need(count <= reference['bytes'], 'closed metadata grew')
            chunks.append(block)
            digest.update(block)
        check()
        need(count == reference['bytes'] and digest.hexdigest() == reference['sha256'] and
             file_identity(os.fstat(fd)) == identity == file_identity(os.lstat(file)),
             'closed metadata bytes or custody changed')
        return b''.join(chunks)
    finally:
        os.close(fd)


def capture_registry_original(*, source_sha, lock_integrity, name, version,
                              output, check, remaining_seconds, reserve, settle):
    need(isinstance(source_sha, str) and re.fullmatch('[0-9a-f]{40}', source_sha), 'exact source SHA')
    need(isinstance(name, str) and len(name) <= 214 and re.fullmatch(r'(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*', name), 'exact package name')
    need(isinstance(version, str) and len(version) <= 128 and re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', version), 'exact package version')
    need(isinstance(lock_integrity, str) and re.fullmatch(r'sha512-[A-Za-z0-9+/]{86}==', lock_integrity), 'complete lock SRI')
    expected = base64.b64decode(lock_integrity[7:], validate=True)
    need(len(expected) == 64 and base64.b64encode(expected).decode() == lock_integrity[7:], 'canonical lock SRI')
    root = Path(output)
    need(root.is_absolute() and root.resolve(strict=True) == root and stat.S_ISDIR(os.lstat(root).st_mode), 'canonical existing output root')
    directories = {}
    closed_files = {}

    def directory_identity(folder):
        info = os.lstat(folder)
        need(stat.S_ISDIR(info.st_mode), 'ordinary retained directory')
        return info.st_dev, info.st_ino, info.st_mode

    directories[root] = directory_identity(root)

    def guard():
        check()
        left = remaining_seconds()
        need(isinstance(left, (float, int)) and math.isfinite(left) and left > 0, 'shared deadline exhausted')
        need(root.resolve(strict=True) == root, 'output root alias changed')
        for folder, identity in directories.items():
            need(directory_identity(folder) == identity, 'retained directory identity changed')
        return min(30, left)

    guard()
    need(shutil.disk_usage(root).free >= LIMITS['freeFloorBytes'], 'existing disk floor')
    directory = root
    for component in ('build-inputs', 'registry', expected.hex()):
        guard()
        directory = directory / component
        directory.mkdir(mode=0o700, exist_ok=True)
        directories[directory] = directory_identity(directory)
    names = ('archive.tgz', 'metadata.json', 'transport.json')
    need(all(not os.path.lexists(directory / file) for file in names), 'original outputs already exist')
    url = 'https://registry.npmjs.org/' + name + '/-/' + name.split('/')[-1] + '-' + version + '.tgz'
    metadata_url = 'https://registry.npmjs.org/' + urllib.parse.quote(name, safe='') + '/' + urllib.parse.quote(version, safe='')
    opener = urllib.request.build_opener(NoRedirect())
    # One metadata original, one final receipt and the one-byte size probe.
    # Every token belongs to the caller's same ledger. Failed attempts retain
    # all reservations and any files, and never emit a successful receipt.
    metadata_token = reserve(2 * METADATA + 1)
    guard()

    def request(address, *, probe=False):
        headers = {'Accept-Encoding': 'identity'}
        if probe:
            headers['Range'] = 'bytes=0-0'
        return opener.open(urllib.request.Request(address, headers=headers), timeout=guard())

    def write_original(file, chunks, maximum):
        guard()
        fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        primary = None
        size = 0
        digest = hashlib.sha256()
        sri = hashlib.sha512()
        try:
            for block in chunks:
                guard()
                need(isinstance(block, bytes) and len(block) <= LIMITS['rangeBytes'], 'bounded raw chunk')
                size += len(block)
                need(size <= maximum, 'retained original byte bound')
                need(shutil.disk_usage(root).free >= LIMITS['freeFloorBytes'], 'existing disk floor')
                digest.update(block)
                sri.update(block)
                offset = 0
                while offset < len(block):
                    guard()
                    count = os.write(fd, block[offset:])
                    need(count > 0, 'closed raw write progress')
                    offset += count
            os.fsync(fd)
            held = os.fstat(fd)
            need(stat.S_ISREG(held.st_mode) and held.st_nlink == 1 and held.st_size == size, 'closed ordinary raw file')
        except BaseException as error:
            primary = error
            raise
        finally:
            try:
                os.close(fd)
            except BaseException:
                if primary is None:
                    raise
        guard()
        current = os.lstat(file)
        need((held.st_dev, held.st_ino, held.st_size, held.st_mtime_ns, held.st_ctime_ns) ==
             (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns, current.st_ctime_ns), 'raw identity after close')
        closed_files[file] = file_identity(current)
        return dict(path=file.relative_to(root).as_posix(), bytes=size, sha256=digest.hexdigest()), sri.digest()

    def read_response(response, maximum):
        # urllib's HTTPS response owns this socket; refresh its timeout at each
        # blocking read rather than allowing the initial timeout to outlive the
        # parent's remaining window. A closed response has no fp and cannot IO.
        guard()
        fp = getattr(response, 'fp', None)
        if fp is not None:
            connection = getattr(getattr(fp, 'raw', None), '_sock', None)
            need(connection is not None, 'held HTTPS response socket required')
            connection.settimeout(guard())
        block = response.read(maximum)
        guard()
        return block

    def stream(response):
        while True:
            guard()
            block = read_response(response, LIMITS['rangeBytes'])
            guard()
            if not block:
                return
            yield block

    with request(metadata_url) as response:
        need(response.status == 200, 'metadata HTTP status')
        metadata_ref, _ = write_original(directory / 'metadata.json', stream(response), METADATA)
    # Metadata remains bounded. Whole archive bytes are never assembled here.
    metadata_path = directory / 'metadata.json'
    metadata = json.loads(read_closed_original(metadata_path, metadata_ref, closed_files[metadata_path], guard))
    need(metadata.get('name') == name and metadata.get('version') == version and
         metadata.get('dist', {}).get('integrity') == lock_integrity and
         metadata.get('dist', {}).get('tarball') == url, 'immutable canonical metadata identity')
    with request(url, probe=True) as response:
        match = re.fullmatch(r'bytes 0-0/(\d+)', response.headers.get('Content-Range', ''))
        need(response.status == 206 and match, 'exact one-byte range sizing required')
        archive_size = int(match.group(1))
        need(0 < archive_size <= LIMITS['shardBytes'] and archive_size <= LIMITS['dependencyBytes'], 'existing archive shard bound')
        guard()
        need(len(read_response(response, 2)) == 1, 'closed one-byte range response')
    guard()
    archive_token = reserve(archive_size)
    guard()
    with request(url) as response:
        need(response.status == 200, 'archive HTTP status')
        archive_ref, actual_sri = write_original(directory / 'archive.tgz', stream(response), archive_size)
    need(archive_ref['bytes'] == archive_size and actual_sri == expected, 'complete actual archive lock SRI')
    guard()
    receipt = dict(schemaVersion=1, kind='registry-build-input-transport', sourceSha=source_sha,
                   url=url, status=200, completed=True, bytes=archive_ref['bytes'], sha256=archive_ref['sha256'])
    encoded = (json.dumps(receipt, separators=(',', ':')) + '\n').encode()
    need(len(encoded) <= METADATA, 'closed transport receipt bound')
    transport_ref, _ = write_original(directory / 'transport.json', [encoded], METADATA)
    guard()
    settle(archive_token, [archive_ref], {archive_ref['path']: archive_size})
    settle(metadata_token, [metadata_ref, transport_ref])
    guard()
    return [archive_ref, metadata_ref, transport_ref]
