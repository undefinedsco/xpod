"""Debian Packages/.deb byte mechanics. No signatures or installed trust issued.

The private controller adapter must separately bind the exact InRelease to its
reviewed signature observation and each selected row to verified SDK shards.
No extraction, maintainer script, dpkg invocation or candidate code is executed.
"""
import bz2
import gzip
import hashlib
import importlib.util
import io
import json
import lzma
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tarfile
import time
import urllib.request
from urllib.parse import quote, urlsplit

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('binary_index_mechanics', HERE / 'sdk-debian-index-bindings.py')
indexes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(indexes)
LIMITS = indexes.LIMITS
CHUNK = LIMITS['rangeBytes']
META = LIMITS['metadataBytes']


def need(value, why):
    if not value:
        raise ValueError('Debian binary originals: ' + why)


def source_identity(fields):
    """Debian Policy 5.6.1: absent Source inherits binary name/version.

    An explicitly supplied source version is preserved (including binNMU
    differences), never guessed by removing a suffix from the binary version.
    """
    name, version = fields.get('package'), fields.get('version')
    need(isinstance(name, str) and re.fullmatch(r'[a-z0-9][a-z0-9+.-]+', name), 'binary package name')
    need(isinstance(version, str) and bool(version) and not re.search(r'\s|[\x00-\x1f\x7f]', version), 'binary package version')
    if 'source' not in fields:
        return dict(name=name, version=version)
    match = re.fullmatch(r'([a-z0-9][a-z0-9+.-]+)(?: \(([^()\s]+)\))?', fields['source'])
    need(match, 'exact Source field grammar')
    return dict(name=match[1], version=match[2] or version)


class BoundedReader:
    def __init__(self, stream, maximum, check):
        self.stream, self.maximum, self.check = stream, maximum, check
        self.count = 0
        self.digest = hashlib.sha256()

    def read(self, size):
        need(type(size) is int and 0 <= size <= CHUNK, 'bounded stream request')
        self.check()
        block = self.stream.read(size)
        self.count += len(block)
        need(self.count <= self.maximum, 'actual stream byte bound')
        self.digest.update(block)
        return block


def codec(stream, name):
    if name.endswith('.gz'):
        return gzip.GzipFile(fileobj=stream)
    if name.endswith('.xz'):
        return lzma.LZMAFile(stream)
    if name.endswith('.bz2'):
        return bz2.BZ2File(stream)
    need(name.endswith(('/Packages', '.tar')), 'unsupported compression requires reviewed decoded original')
    return stream


def verify_packages(inrelease, stream, signed_path, requests, check=lambda: None, require_all=True):
    """Verify complete index bytes and exact requested binary coordinates.

    stream is the actual original at signed_path, including compression. Apt
    local .lz4 must first be retained decoded and supplied as signed /Packages.
    Caller path labels cannot substitute for the full signed checksum match.
    """
    need(re.fullmatch(r'(main|contrib|non-free|non-free-firmware)/binary-(amd64|arm64)/Packages(?:\.(gz|xz|bz2))?', signed_path), 'fixed signed binary index path')
    signed = indexes.release_checksums(inrelease)
    body = inrelease.partition(b'\n\n')[2].partition(b'\n-----BEGIN PGP SIGNATURE-----\n')[0]
    fields = indexes.stanza([line[2:] if line.startswith(b'- ') else line for line in body.split(b'\n')])
    component, binary_arch = signed_path.split('/')[:2]
    need(component in [value.removeprefix('updates/') for value in fields.get('components', '').split()]
         and binary_arch.removeprefix('binary-') in fields.get('architectures', '').split(), 'signed component/architecture declaration differs')
    expected = signed.get(signed_path)
    need(expected and expected['bytes'] <= LIMITS['shardBytes'], 'signed bounded Packages entry required')
    need(isinstance(requests, list) and 0 < len(requests) <= 4096, 'bounded requested binary set')
    wanted = {}
    for request in requests:
        key = (request['package'], request['version'], request['architecture'])
        need(key not in wanted and key[2] in ('amd64', 'arm64', 'all'), 'unique binary coordinates')
        need(key[2] == 'all' or '/binary-' + key[2] + '/' in signed_path, 'requested binary architecture differs')
        wanted[key] = request
    raw = BoundedReader(stream, expected['bytes'], check)
    plain = codec(raw, signed_path)
    found, lines, pending, expanded, stanza_bytes, stanza_count = {}, [], b'', 0, 0, 0

    def finish():
        nonlocal lines, stanza_bytes, stanza_count
        if not lines:
            return
        fields = indexes.stanza(lines)
        stanza_count += 1
        need(stanza_count <= LIMITS['sourceMembers'], 'Packages stanza count bound')
        key = (fields.get('package'), fields.get('version'), fields.get('architecture'))
        if key in wanted:
            need(key not in found, 'ambiguous exact Packages coordinate')
            filename, size, sha = fields.get('filename'), fields.get('size'), fields.get('sha256')
            need(indexes.safe(filename) and filename.startswith('pool/') and filename.endswith('.deb'), 'safe exact signed pool Filename')
            need(isinstance(size, str) and re.fullmatch(r'[0-9]+', size) and 0 < int(size) <= LIMITS['shardBytes'], 'signed deb byte bound')
            need(isinstance(sha, str) and re.fullmatch(r'[a-f0-9]{64}', sha), 'signed deb full SHA256')
            source = source_identity(fields)
            requested = wanted[key]
            need(source == requested['source'], 'signed Source tuple differs from actual package ledger')
            found[key] = dict(package=key[0], version=key[1], architecture=key[2], source=source,
                              filename=filename, bytes=int(size), sha256=sha)
        lines, stanza_bytes = [], 0

    while True:
        check()
        block = plain.read(CHUNK)
        if not block:
            break
        expanded += len(block)
        need(expanded <= LIMITS['sourceBytes'], 'decoded Packages byte bound')
        pending += block
        while b'\n' in pending:
            line, pending = pending.split(b'\n', 1)
            need(stanza_bytes + len(line) + 1 <= META, 'Packages stanza byte bound')
            if not line:
                finish()
            else:
                stanza_bytes += len(line) + 1
                need(stanza_bytes <= META, 'Packages stanza byte bound')
                lines.append(line)
        need(stanza_bytes + len(pending) <= META, 'unfinished Packages stanza byte bound')
    if pending:
        need(stanza_bytes + len(pending) <= META, 'Packages final stanza byte bound')
        lines.append(pending)
    finish()
    need(raw.count == expected['bytes'] and raw.digest.hexdigest() == expected['sha256'], 'complete Packages signed checksum differs')
    need(not require_all or set(found) == set(wanted), 'exact installed binary coordinate missing from signed Packages')
    return [found[key] for key in wanted if key in found]


class Segment:
    def __init__(self, raw, size):
        self.raw, self.remaining = raw, size

    def read(self, size):
        need(type(size) is int and 0 <= size <= CHUNK, 'bounded ar payload read')
        if size == 0:
            return b''
        block = self.raw.read(min(size, self.remaining))
        need(block or not self.remaining, 'truncated ar payload')
        self.remaining -= len(block)
        return block

    def drain(self):
        while self.read(CHUNK):
            pass


class TarHeaderGuard:
    """Audit raw 512-byte records before tarfile can auto-buffer metadata.

    tarfile hides GNU/PAX records from iteration and eagerly reads their padded
    payload. The same per-deb ledger covers control and data tar metadata.
    Only the 512-byte header and bounded PAX payload are retained here.
    """
    EXTENDED = (tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK,
                tarfile.XHDTYPE, tarfile.XGLTYPE)

    def __init__(self, stream, ledger, check, *, metadata_members=128):
        need(type(metadata_members) is int and 0 < metadata_members <= LIMITS['sourceMembers'], 'declared tar metadata member bound')
        self.metadata_members = metadata_members
        self.stream, self.ledger, self.check = stream, ledger, check
        self.header = bytearray()
        self.payload = self.padding = 0
        self.kind = None
        self.pax = bytearray()
        self.pending_size = None
        self.eof_blocks = 0

    def finish_pax(self):
        data, at, fields = self.pax, 0, {}
        while at < len(data):
            self.check()
            space = data.find(b' ', at)
            need(space > at and space - at <= 10 and data[at:space].isdigit(), 'bounded PAX length prefix')
            length = int(data[at:space])
            need(length > space - at + 2 and at + length <= len(data) and data[at + length - 1] == 10, 'complete PAX record')
            key, sep, value = bytes(data[space + 1:at + length - 1]).partition(b'=')
            need(sep and key in (b'path', b'linkpath', b'mtime', b'atime', b'ctime', b'uid', b'gid', b'uname', b'gname', b'size')
                 and key not in fields, 'unsupported/duplicate PAX semantics')
            fields[key] = value
            if key in (b'path', b'linkpath'):
                need(len(value) <= 4096, 'PAX path length bound')
            if key == b'size':
                need(self.kind == tarfile.XHDTYPE and len(value) <= 12 and value.isdigit()
                     and int(value) <= LIMITS['shardBytes'], 'bounded local PAX size required')
                self.pending_size = int(value)
            at += length
        self.pax = bytearray()

    def read(self, size):
        need(type(size) is int and 0 <= size <= CHUNK, 'bounded guarded tar read')
        if size == 0:
            return b''
        block = self.stream.read(size)
        at = 0
        while at < len(block):
            self.check()
            if self.payload:
                count = min(self.payload, len(block) - at)
                if self.kind in (tarfile.XHDTYPE, tarfile.XGLTYPE):
                    self.pax.extend(block[at:at + count])
                self.payload -= count
                at += count
                if not self.payload and self.kind in (tarfile.XHDTYPE, tarfile.XGLTYPE):
                    self.finish_pax()
                continue
            if self.padding:
                count = min(self.padding, len(block) - at)
                need(not any(block[at:at + count]), 'nonzero guarded tar padding')
                self.padding -= count
                at += count
                continue
            count = min(512 - len(self.header), len(block) - at)
            self.header.extend(block[at:at + count])
            at += count
            if len(self.header) != 512:
                continue
            header = bytes(self.header)
            self.header.clear()
            if not any(header):
                self.eof_blocks += 1
                continue
            need(not self.eof_blocks, 'nonzero member after guarded tar EOF')
            item = tarfile.TarInfo.frombuf(header, 'utf-8', 'strict')
            need(type(item.size) is int and 0 <= item.size <= LIMITS['shardBytes'], 'bounded raw tar member size')
            self.kind = item.type
            padded = (item.size + 511) // 512 * 512
            if item.type in self.EXTENDED:
                need(self.pending_size is None, 'PAX size followed by nested extended metadata')
                self.ledger['members'] += 1
                self.ledger['bytes'] += padded
                need(0 < padded <= META and self.ledger['bytes'] <= META and self.ledger['members'] <= self.metadata_members,
                     'GNU/PAX metadata single/aggregate byte/member bound')
            else:
                need(item.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE, tarfile.SYMTYPE, tarfile.LNKTYPE), 'unsupported guarded tar semantics')
                if self.pending_size is not None:
                    need(item.size == self.pending_size, 'PAX/raw regular size disagreement')
                    self.pending_size = None
            self.payload, self.padding = item.size, padded - item.size
        if not block:
            need(not self.header and not self.payload and not self.padding and self.pending_size is None and self.eof_blocks >= 2,
                 'complete guarded tar framing and double EOF required')
        return block


def verify_deb(stream, expected, selected, check=lambda: None):
    """Match selected regular data members; links remain explicit unresolved.

    This first slice deliberately does not manufacture symlink/hardlink
    identity: a later same-SDK alias resolver must bind its actual shard target.
    """
    need(type(expected['bytes']) is int and 0 < expected['bytes'] <= LIMITS['shardBytes'], 'deb original bound')
    raw = BoundedReader(stream, expected['bytes'], check)
    need(raw.read(8) == b'!<arch>\n', 'Debian ar magic')
    need(isinstance(selected, list) and len(selected) <= LIMITS['sourceMembers'], 'selected data member set')
    wanted = {}
    for row in selected:
        path = row['dataPath']
        need(indexes.safe(path) and path not in wanted and type(row['bytes']) is int and 0 <= row['bytes'] <= LIMITS['shardBytes']
             and re.fullmatch(r'[a-f0-9]{64}', row['sha256']) and type(row['mode']) is int, 'exact selected installed original')
        wanted[path] = row
    names, files, links, control, expanded = [], {}, {}, None, 0
    metadata_ledger = dict(bytes=0, members=0)
    while raw.count < expected['bytes']:
        header = raw.read(60)
        need(len(header) == 60 and header[58:] == b'`\n', 'complete ar member header')
        name = header[:16].decode('ascii').rstrip().removesuffix('/')
        size_text = header[48:58].decode('ascii').strip()
        need(re.fullmatch('[0-9]+', size_text), 'decimal ar member size')
        size = int(size_text)
        need(size <= expected['bytes'] - raw.count, 'ar member size within original')
        names.append(name)
        need(len(names) <= 3 and len(names) == len(set(names)), 'canonical unique Debian ar members')
        payload = Segment(raw, size)
        if len(names) == 1:
            need(name == 'debian-binary' and size == 4 and payload.read(4) == b'2.0\n', 'Debian format version')
        else:
            domain = 'control' if len(names) == 2 else 'data'
            need(re.fullmatch(domain + r'\.tar(?:\.(?:gz|xz|bz2))?', name), 'unsupported or misplaced Debian tar member')
            decoded = TarHeaderGuard(BoundedReader(codec(payload, name), LIMITS['sourceMaterialBytes'], check), metadata_ledger, check)
            seen = set()
            with tarfile.open(fileobj=decoded, mode='r|', bufsize=CHUNK) as archive:
                for member in archive:
                    check()
                    path = member.name.removeprefix('./').rstrip('/')
                    if path in ('', '.') and member.isdir():
                        continue
                    need(indexes.safe(path) and path not in seen and len(seen) < LIMITS['sourceMembers'], 'safe unique deb tar member')
                    seen.add(path)
                    need(member.isfile() or member.isdir() or member.issym() or member.islnk(), 'unsupported Debian data member type')
                    if member.isdir():
                        need(member.size == 0, 'directory payload refused')
                        continue
                    if not member.isfile():
                        need(domain == 'data' and member.size == 0, 'control link or link payload refused')
                        if path in wanted:
                            links[path] = dict(path=path, target=member.linkname, reason='deb-alias-to-installed-shard-target-unverified')
                        continue
                    need(0 <= member.size <= LIMITS['shardBytes'], 'Debian regular member byte bound')
                    body = archive.extractfile(member)
                    digest, count, parts = hashlib.sha256(), 0, []
                    while True:
                        check()
                        block = body.read(CHUNK)
                        if not block:
                            break
                        count += len(block)
                        expanded += len(block)
                        need(count <= member.size and expanded <= LIMITS['sourceMaterialBytes'], 'Debian actual data aggregate bound')
                        digest.update(block)
                        if domain == 'control' and path == 'control':
                            need(count <= META, 'bounded deb control original')
                            parts.append(block)
                    need(count == member.size, 'truncated Debian data member')
                    if domain == 'control' and path == 'control':
                        control = indexes.stanza(b''.join(parts).rstrip(b'\n').split(b'\n'))
                    if domain == 'data' and path in wanted:
                        row = wanted[path]
                        need(count == row['bytes'] and digest.hexdigest() == row['sha256'] and member.mode == row['mode'], 'deb member differs from actual installed original')
                        files[path] = dict(dataPath=path, bytes=count, sha256=digest.hexdigest(), mode=member.mode)
                zeros = 0
                while True:
                    tail = archive.fileobj.read(CHUNK)
                    if not tail:
                        break
                    zeros += len(tail)
                    need(not any(tail), 'nonzero data after Debian tar EOF')
                need(zeros >= 512, 'second Debian tar EOF block required')
            # Drain all compressed bytes to EOF/CRC; tarfile stopping at its
            # first EOF never permits a second hidden nonzero tar archive.
            while True:
                tail = decoded.read(CHUNK)
                if not tail:
                    break
                need(not any(tail), 'nonzero data after Debian tar EOF')
            payload.drain()
        need(payload.remaining == 0, 'complete ar payload')
        if size % 2:
            need(raw.read(1) == b'\n', 'canonical ar padding')
    need(len(names) == 3 and raw.count == expected['bytes'] and raw.digest.hexdigest() == expected['sha256'], 'complete deb signed SHA256 differs')
    need(control and (control.get('package'), control.get('version'), control.get('architecture')) ==
         (expected['package'], expected['version'], expected['architecture']) and source_identity(control) == expected['source'], 'deb control differs from signed binary/source coordinates')
    need(set(files) | set(links) == set(wanted), 'selected installed path absent from actual deb')
    return dict(files=[files[path] for path in wanted if path in files], unresolved=[links[path] for path in wanted if path in links],
                debBytes=raw.count, debSha256=raw.digest.hexdigest(), scope='signed-coordinate/data-byte mechanics only; authority independently required')


def identity(row):
    return row.st_dev, row.st_ino, row.st_mode, row.st_size, row.st_mtime_ns, row.st_ctime_ns


def regular(path, maximum, check):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_size <= maximum, 'bounded regular metadata original')
        parts, count = [], 0
        while True:
            check()
            block = os.read(fd, CHUNK)
            if not block:
                break
            count += len(block)
            need(count <= before.st_size, 'metadata original grew')
            parts.append(block)
        need(count == before.st_size and identity(before) == identity(os.fstat(fd)) == identity(Path(path).lstat()), 'metadata original changed')
        return b''.join(parts)
    finally:
        os.close(fd)


def retained(out, reference, maximum, check):
    need(indexes.safe(reference['path']) and type(reference['bytes']) is int and 0 <= reference['bytes'] <= maximum, 'bounded relative original reference')
    raw = regular(out / reference['path'], reference['bytes'], check)
    need(len(raw) == reference['bytes'] and hashlib.sha256(raw).hexdigest() == reference['sha256'], 'retained original reference differs')
    return raw


def download_exact(url, destination, size, digest):
    """Owned child command, always supervised by the caller's existing stage.

    The URL is transport only. Size/SHA derive from full Packages bytes; the
    private consumer must independently authenticate that Packages checksum.
    """
    parsed = urlsplit(url)
    need(parsed.scheme == 'https' and parsed.netloc in ('deb.debian.org', 'security.debian.org')
         and not parsed.query and not parsed.fragment and not parsed.username
         and (parsed.path.startswith('/debian/pool/') or parsed.path.startswith('/debian-security/pool/')), 'fixed Debian transport URL')
    need(type(size) is int and 0 < size <= LIMITS['shardBytes'] and re.fullmatch('[a-f0-9]{64}', digest), 'fixed transport byte/hash bound')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            raise ValueError('Debian binary redirect refused')
    opener = urllib.request.build_opener(NoRedirect())
    with opener.open(urllib.request.Request(url, headers={'Accept-Encoding': 'identity', 'User-Agent': 'xpod-sdk-originals'}), timeout=30) as response:
        need(response.status == 200 and response.geturl() == url and response.headers.get('Content-Encoding', 'identity') == 'identity', 'exact Debian response required')
        if response.headers.get('Content-Length') is not None:
            need(response.headers['Content-Length'].isdigit() and int(response.headers['Content-Length']) == size, 'Debian Content-Length differs')
        count, actual = 0, hashlib.sha256()
        with Path(destination).open('xb') as output:
            while True:
                block = response.read(min(CHUNK, size - count + 1))
                if not block:
                    break
                count += len(block)
                need(count <= size and shutil.disk_usage(output.name).free >= 2 * 1024 ** 3, 'Debian transport size/disk bound')
                output.write(block)
                actual.update(block)
            output.flush()
            os.fsync(output.fileno())
        need(count == size and actual.hexdigest() == digest, 'actual Debian transport bytes differ from Packages')


def acquire(out, selected_rows, ownership_originals, ledger_ref, target, remaining_bytes, stage, ref, check_budget,
            *, lists=Path('/var/lib/apt/lists'),security_suite='bookworm-security'):
    """Producer mechanical collection, never official binary authority.

    ownership_originals=[{originalPath:'/var/lib/dpkg/info/<name>.list',
      original:{path:'ownership-originals/<name>.list',bytes,sha256}}].
    remaining_bytes() is the caller's actual *all-out* remaining ledger. Every
    child uses stage(), sharing its absolute owner deadline and closed receipts.
    Return bytes count only newly created originals, including external stage
    stdout/receipts; existing ownership/ledger originals are never charged twice.
    """
    out, lists = Path(out).resolve(strict=True), Path(lists)
    architecture = {'linux-x64': 'amd64', 'linux-arm64': 'arm64'}.get(target)
    need(architecture and callable(remaining_bytes), 'fixed SDK target and actual remaining callback required')
    existing = {p.resolve() for p in out.rglob('*') if p.is_file()}
    destination = out / 'debian-binary'
    destination.mkdir(exist_ok=False)
    def budget():
        check_budget()
        need(type(remaining_bytes()) is int and remaining_bytes() >= 0, 'remaining shared source domain exhausted')
    def preserve(path, target, maximum):
        budget()
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            before = os.fstat(fd)
            need(stat.S_ISREG(before.st_mode) and before.st_size <= min(maximum, remaining_bytes()), 'bounded index original')
            count = 0
            with target.open('xb') as output:
                while True:
                    budget()
                    block = os.read(fd, CHUNK)
                    if not block:
                        break
                    count += len(block)
                    need(count <= before.st_size and len(block) <= remaining_bytes(), 'index original growth/shared budget')
                    output.write(block)
                output.flush()
                os.fsync(output.fileno())
            need(count == before.st_size and identity(before) == identity(os.fstat(fd)) == identity(Path(path).lstat()), 'index original custody changed')
        finally:
            os.close(fd)
        budget()
        return ref(target, out)
    ledger_raw = retained(out, ledger_ref, META, check_budget)
    legacy = {}
    for line in ledger_raw.decode('utf-8').splitlines():
        values = line.split('\t')
        need(len(values) == 4 and values[0] not in legacy, 'actual four-column source ledger')
        legacy[values[0]] = values
    ledger_stage = stage('debian-binary-identities', ['dpkg-query', '-W', '-f=${binary:Package}\t${Version}\t${Architecture}\t${source:Package}\t${source:Version}\n'], out)
    budget()
    binary_raw = retained(out, ledger_stage['stdout'], META, check_budget)
    binaries = {}
    for line in binary_raw.decode('utf-8').splitlines():
        values = line.split('\t')
        need(len(values) == 5 and values[0] not in binaries, 'actual unique binary/architecture ledger')
        old = legacy.get(values[0])
        need(old and old == [values[0], values[1], values[3], values[4]], 'binary/source ledger actual tuple drift')
        binaries[values[0]] = dict(package=values[0].split(':')[0], version=values[1], architecture=values[2], source=dict(name=values[3], version=values[4]))
    selected = {}
    for row in selected_rows:
        path = row['originalPath']
        need(path not in selected and path.startswith('/') and type(row['bytes']) is int and re.fullmatch('[a-f0-9]{64}', row['sha256']), 'unique actual installed shard row')
        selected[path] = row
    owned, ownership_total = {}, 0
    for row in ownership_originals:
        path = Path(row['originalPath'])
        need(path.parent == Path('/var/lib/dpkg/info') and path.name.endswith('.list'), 'fixed actual ownership origin')
        name = path.name[:-5]
        need(name in binaries and name not in owned, 'actual binary ledger ownership coordinate')
        raw = retained(out, row['original'], META, check_budget)
        ownership_total += len(raw)
        need(ownership_total <= 16 * 1024 ** 2 and regular(path, META, check_budget) == raw, 'actual ownership originals differ/budget')
        paths = {}
        for original in raw.decode('utf-8').splitlines():
            check_budget()
            need(original.startswith('/') and '\0' not in original, 'absolute dpkg ownership line')
            resolved = str(Path(original).resolve())
            if resolved in selected:
                # Prefer the actual regular member over a .list symlink alias
                # resolving to that same installed inode (common for DSOs).
                previous = paths.get(resolved)
                if previous is None or original == resolved or (Path('/' + previous).is_symlink() and not Path(original).is_symlink()):
                    paths[resolved] = original.lstrip('/')
        if paths:
            owned[name] = (binaries[name], paths)
    need(owned and len(owned) <= 4096, 'actual selected Debian binary packages required')
    requests = [coordinate for coordinate, _ in owned.values()]
    kept_indexes, found = [], {}
    index_directory = destination / 'indexes'
    index_directory.mkdir()
    for path in sorted(lists.iterdir()):
        match = re.fullmatch(r'(.+_)((?:main|contrib|non-free|non-free-firmware))_binary-' + architecture + r'_Packages(?:\.(?:gz|xz|bz2|lz4))?', path.name)
        if not match:
            continue
        release = lists / (match[1] + 'InRelease')
        release_ref = preserve(release, index_directory / release.name, META) if not (index_directory / release.name).exists() else ref(index_directory / release.name, out)
        package_ref = preserve(path, index_directory / path.name, LIMITS['shardBytes'])
        decoded, decoding_stage = package_ref, None
        signed_path = match[2] + '/binary-' + architecture + '/Packages'
        if path.suffix == '.lz4':
            decoding_stage = stage('debian-binary-decode-' + str(len(kept_indexes)), ['/usr/lib/apt/apt-helper', 'cat-file', str(index_directory / path.name)], out)
            budget()
            decoded = preserve(out / decoding_stage['stdout']['path'], index_directory / (path.name + '.decoded'), LIMITS['shardBytes'])
        elif path.suffix in ('.gz', '.xz', '.bz2'):
            signed_path += path.suffix
        release_raw = retained(out, release_ref, META, check_budget)
        with (out / decoded['path']).open('rb') as original:
            matches = verify_packages(release_raw, original, signed_path, requests, check_budget, require_all=False)
        index_row = dict(inRelease=release_ref, packages=package_ref, decodedPackages=decoded, signedIndexPath=signed_path)
        if decoding_stage:
            index_row['decodingStage'] = decoding_stage
        kept_indexes.append(index_row)
        for coordinate in matches:
            key = (coordinate['package'], coordinate['version'], coordinate['architecture'])
            if key in found:
                need(found[key][0] == coordinate, 'multiple signed index byte identities for one exact binary')
            else:
                found[key] = (coordinate, index_row)
    packages, covered = [], set()
    for name, (request, paths) in owned.items():
        key = (request['package'], request['version'], request['architecture'])
        need(key in found, 'actual installed binary missing from retained signed index coordinates')
        coordinate, index_row = found[key]
        directory = destination / ('package-' + str(len(packages)).zfill(4))
        directory.mkdir()
        need(re.fullmatch(r'pool/[A-Za-z0-9+._~/-]+\.deb', coordinate['filename']), 'canonical exact pool Filename')
        release_name = Path(index_row['inRelease']['path']).name
        need(re.fullmatch(r'[a-z0-9]+-security',security_suite) is not None,'declared canonical security suite')
        security = ('_dists_'+security_suite+'_') in release_name
        base = 'https://security.debian.org/debian-security/' if security else 'https://deb.debian.org/debian/'
        url = base + quote(coordinate['filename'], safe='/+~._-')
        budget()
        need(coordinate['bytes'] <= remaining_bytes(), 'deb download exceeds actual shared remaining')
        deb_path = directory / 'original.deb'
        acquisition = stage('debian-binary-download-' + str(len(packages)), [sys.executable, '-I', '-S', '-B', str(Path(__file__).resolve()), '--download', url, str(deb_path), str(coordinate['bytes']), coordinate['sha256']], out)
        budget()
        selected_members = [dict(dataPath=data_path, bytes=selected[path]['bytes'], sha256=selected[path]['sha256'], mode=selected[path]['mode']) for path, data_path in paths.items()]
        fd = os.open(deb_path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            before = os.fstat(fd)
            need(stat.S_ISREG(before.st_mode) and before.st_size == coordinate['bytes'], 'actual retained deb file size')
            with os.fdopen(os.dup(fd), 'rb') as original:
                observed = verify_deb(original, coordinate, selected_members, check_budget)
            need(identity(before) == identity(os.fstat(fd)) == identity(deb_path.lstat()), 'deb original changed during inspection')
        finally:
            os.close(fd)
        installed = [dict(originalPath=path, dataPath=data_path, bytes=selected[path]['bytes'], sha256=selected[path]['sha256'], mode=selected[path]['mode']) for path, data_path in paths.items()]
        covered.update(paths)
        packages.append(dict(**request, index=index_row, deb=ref(deb_path, out), filename=coordinate['filename'], installed=installed, byteObservation=observed, acquisition=acquisition))
    budget()
    result = dict(schemaVersion=1, kind='qlever-sdk-exact-debian-binary-originals', target=target,
                  sourceIdentities=ledger_ref, binaryIdentities=ledger_stage['stdout'], binaryIdentityStage=ledger_stage,
                  ownershipOriginals=ownership_originals, indexOriginals=kept_indexes, packages=packages,
                  unresolvedInputs=[dict(originalPath=path, reason='selected-input-has-no-retained-dpkg-ownership') for path in selected if path not in covered],
                  pending=['Debian-binary-signature-and-installed-byte-private-admission-required'])
    target_path = destination / 'materials.json'
    encoded = (json.dumps(result, sort_keys=True, indent=2) + '\n').encode()
    need(len(encoded) <= META and len(encoded) <= remaining_bytes(), 'binary collection metadata remaining bound')
    with target_path.open('xb') as output:
        output.write(encoded)
    budget()
    created = {p.resolve() for p in out.rglob('*') if p.is_file()} - existing
    return ref(target_path, out), sum(path.stat().st_size for path in created)


def observe_sdk(archive_path, plan):
    """Bounded same-SDK ZIP math. The TS private adapter supplies live facts.

    The returned JSON is deliberately not an authority capability.
    """
    spec = importlib.util.spec_from_file_location('binary_zip_originals', HERE / 'sdk-zip-originals.py')
    zip_originals = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(zip_originals)
    remaining = plan['remainingMilliseconds']
    need(type(remaining) in (int, float) and 0 < remaining <= LIMITS['timeoutMs'], 'shared binary observation deadline')
    deadline = time.monotonic() + remaining / 1000
    def check():
        need(time.monotonic() < deadline, 'binary observation deadline expired')
    collection = plan['collection']
    need(collection['schemaVersion'] == 1 and collection['kind'] == 'qlever-sdk-exact-debian-binary-originals', 'actual binary collection schema')
    need(collection['target'] in ('linux-x64', 'linux-arm64'), 'actual binary target')
    architecture = {'linux-x64': 'amd64', 'linux-arm64': 'arm64'}[collection['target']]
    verified, sources = {}, set()
    for row in plan['verifiedRows']:
        need(row['originalPath'] not in verified, 'unique private installed shard rows')
        verified[row['originalPath']] = row
    for row in plan['sourceCoordinates']:
        sources.add((row['name'], row['version']))
    signed = set(plan['signatureReleaseSha256'])
    need(signed and sources and verified, 'same private signature/source/installed observations required')
    with zip_originals.registered_zip_originals(archive_path, 'inner/debian-binary/', check) as member:
        referenced, counted = {}, 0
        def register(reference):
            nonlocal counted
            path = reference['path']
            need(indexes.safe(path) and path.startswith('inner/debian-binary/'), 'registered binary original domain')
            if path in referenced:
                need(referenced[path] == reference, 'ambiguous binary reference')
            else:
                need(type(reference['bytes']) is int and 0 <= reference['bytes'] <= LIMITS['shardBytes'], 'binary member byte bound')
                referenced[path] = reference
                counted += reference['bytes']
                need(counted <= LIMITS['sourceMaterialBytes'], 'unique binary originals aggregate bound')
            return reference
        def small(reference):
            register(reference)
            need(reference['bytes'] <= META, 'small binary metadata')
            with member(reference) as original:
                raw = original.read(reference['bytes'] + 1)
            need(len(raw) == reference['bytes'] and hashlib.sha256(raw).hexdigest() == reference['sha256'], 'full binary metadata SHA')
            return raw
        packages = collection['packages']
        need(isinstance(packages, list) and 0 < len(packages) <= 4096, 'bounded binary package set')
        requests = []
        for package in packages:
            coordinate = {key: package[key] for key in ('package', 'version', 'architecture', 'source')}
            need(coordinate['architecture'] in (architecture, 'all') and (coordinate['source']['name'], coordinate['source']['version']) in sources, 'binary source tuple lacks actual signed Sources match')
            requests.append(coordinate)
        resolved = {}
        for index in collection['indexOriginals']:
            release = index['inRelease']
            need(release['sha256'] in signed, 'same privately authenticated InRelease required')
            release_raw = small(release)
            original, decoded = register(index['packages']), register(index['decodedPackages'])
            # Even decoded apt lists retain their actual compressed original.
            # Reading every compressed original verifies custody, not codec trust.
            if original != decoded:
                with member(original) as stream:
                    digest, count = hashlib.sha256(), 0
                    while True:
                        check()
                        block = stream.read(CHUNK)
                        if not block:
                            break
                        count += len(block)
                        need(count <= original['bytes'], 'compressed apt list original grew')
                        digest.update(block)
                    need(count == original['bytes'] and digest.hexdigest() == original['sha256'], 'full original apt list hash differs')
            with member(decoded) as stream:
                rows = verify_packages(release_raw, stream, index['signedIndexPath'], requests, check, require_all=False)
            for row in rows:
                key = (row['package'], row['version'], row['architecture'])
                if key in resolved:
                    need(resolved[key][0] == row, 'ambiguous signed binary coordinates')
                else:
                    resolved[key] = (row, index)
        files, unresolved, installed_paths = [], [], set()
        for package in packages:
            check()
            key = (package['package'], package['version'], package['architecture'])
            need(key in resolved, 'exact binary absent from signed Packages')
            coordinate, index = resolved[key]
            need(package['index'] == index and package['filename'] == coordinate['filename'], 'binary selected index/Filename differs')
            deb = register(package['deb'])
            need(deb['bytes'] == coordinate['bytes'] and deb['sha256'] == coordinate['sha256'], 'actual deb differs from signed Size/SHA256')
            selected = []
            need(isinstance(package['installed'], list) and package['installed'], 'actual selected installed byte set')
            for row in package['installed']:
                path = row['originalPath']
                need(path in verified and path not in installed_paths, 'installed path not in same complete private SDK shards or ambiguous')
                actual = verified[path]
                need(all(actual[field] == row[field] for field in ('bytes', 'sha256', 'mode')), 'installed byte/mode differs from private full-shard original')
                installed_paths.add(path)
                # A producer-selected dataPath does not establish an installed
                # alias. Byte equality alone cannot move a Debian identity to
                # an arbitrary build/generated path. A future private alias
                # observation may bridge usr-merge paths; no JSON does so here.
                if path == '/' + row['dataPath']:
                    selected.append({key: row[key] for key in ('dataPath', 'bytes', 'sha256', 'mode')})
            with member(deb) as stream:
                observed = verify_deb(stream, coordinate, selected, check)
            by_path = {row['dataPath']: row for row in observed['files']}
            for installed in package['installed']:
                if installed['originalPath'] != '/' + installed['dataPath']:
                    unresolved.append(dict(installedPath=installed['originalPath'], reason='deb-member-to-installed-path-or-alias-binding-unverified'))
                elif installed['dataPath'] in by_path:
                    files.append(dict(installedPath=installed['originalPath'], bytes=installed['bytes'], sha256=installed['sha256'], mode=installed['mode'],
                                      binary=dict(name=coordinate['package'], version=coordinate['version'], architecture=coordinate['architecture']), source=coordinate['source'], deb=deb,
                                      packages=dict(**decoded, signedIndexPath=index['signedIndexPath'], inReleaseSha256=index['inRelease']['sha256']), dataMemberPath=installed['dataPath']))
                else:
                    unresolved.append(dict(installedPath=installed['originalPath'], reason='deb-alias-to-installed-shard-target-unverified'))
        need({name for name in member.names if name.startswith('inner/debian-binary/')} == set(referenced) | {'inner/debian-binary/materials.json'}, 'binary ZIP domain exact original set differs')
        check()
        return dict(schemaVersion=1, kind='qlever-sdk-Debian-binary-installed-byte-mechanics', files=files, unresolved=unresolved,
                    officialAuthorityIssued=False, wholeToolchainVerified=False)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--observe-sdk':
        raw = sys.stdin.buffer.read(META + 1)
        need(len(raw) <= META, 'bounded binary observer plan')
        print(json.dumps(observe_sdk(sys.argv[2], json.loads(raw)), separators=(',', ':')))
    else:
        need(len(sys.argv) == 6 and sys.argv[1] == '--download', 'private supervised download child arguments')
        download_exact(sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5])
