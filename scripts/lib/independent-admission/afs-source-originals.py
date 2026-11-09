"""Read-only bounded AgentFS nested source archive mechanics; never execute input."""
import hashlib
import gzip
import json
import re
import sys
import tarfile
import time
import zipfile
from pathlib import Path
LIMITS = json.loads((Path(__file__).parents[1] / 'module-artifact-limits.json').read_text())

def need(value, reason):
    if not value:
        raise ValueError('AFS source originals: ' + reason)

def safe(name):
    return isinstance(name, str) and bool(name) and not name.startswith('/') and '\\' not in name and not any(ord(c) < 32 or ord(c) == 127 for c in name) and all(p not in ('', '.', '..') for p in name.split('/'))

class BoundReader:
    def __init__(self, stream, maximum, check):
        self.stream, self.maximum, self.check, self.count = stream, maximum, check, 0
        self.digest = hashlib.sha256()
    def read(self, size=-1):
        self.check()
        need(0 <= size <= LIMITS['rangeBytes'], 'bounded stream request required')
        data = self.stream.read(size)
        self.count += len(data)
        need(self.count <= self.maximum, 'stream aggregate byte bound')
        self.digest.update(data)
        return data
    def drain(self):
        while self.read(LIMITS['rangeBytes']):
            pass

def tar_members(stream, maximum, check):
    total, names, next_name, zeros = 0, set(), None, 0
    def take(size):
        nonlocal total
        need(0 <= size <= LIMITS['rangeBytes'], 'tar read bound')
        check(); data = stream.read(size); total += len(data)
        need(total <= maximum, 'expanded archive byte bound')
        return data
    def exact(size):
        chunks, count = [], 0
        while count < size:
            data = take(min(LIMITS['rangeBytes'], size-count)); need(data, 'truncated tar original')
            chunks.append(data); count += len(data)
        return b''.join(chunks)
    class Payload:
        def __init__(self, size): self.remaining = size
        def read(self, size):
            need(0 <= size <= LIMITS['rangeBytes'], 'payload range bound')
            if not self.remaining: return b''
            data = take(min(size, self.remaining)); need(data, 'truncated member')
            self.remaining -= len(data); return data
        def drain(self):
            while self.read(LIMITS['rangeBytes']): pass
    while True:
        header = exact(512)
        if not any(header):
            zeros += 1
            if zeros == 2:
                need(next_name is None, 'orphan extended name')
                while True:
                    tail = take(LIMITS['rangeBytes'])
                    if not tail: return
                    need(not any(tail), 'nonzero data after tar EOF')
            continue
        need(zeros == 0, 'member after single tar EOF')
        item = tarfile.TarInfo.frombuf(header, 'utf-8', 'strict')
        need(item.size >= 0, 'nonnegative member size required')
        payload = Payload(item.size)
        if item.type in (tarfile.XHDTYPE, tarfile.GNUTYPE_LONGNAME):
            need(0 < item.size <= 65536 and next_name is None, 'bounded unique extended name required')
            raw = exact(item.size); payload.remaining = 0
            if item.type == tarfile.GNUTYPE_LONGNAME:
                need(raw.endswith(b'\0') and b'\0' not in raw[:-1], 'canonical GNU name')
                next_name = raw[:-1].decode('utf-8')
            else:
                at = 0
                while at < len(raw):
                    space = raw.find(b' ', at); need(space > at, 'PAX length')
                    length = int(raw[at:space]); need(length > space-at+2 and at+length <= len(raw) and raw[at+length-1] == 10, 'PAX record bound')
                    key, value = raw[space+1:at+length-1].decode('utf-8').split('=', 1)
                    need(key in ('path','mtime','atime','ctime'), 'unsupported PAX semantics')
                    if key == 'path': need(next_name is None, 'duplicate PAX path'); next_name = value
                    at += length
        else:
            name = (next_name if next_name is not None else item.name).removeprefix('./').rstrip('/')
            next_name = None
            need(safe(name) and name not in names and len(names) < LIMITS['sourceMembers'], 'safe unique tar members required')
            names.add(name)
            need(item.isfile() or item.isdir(), 'only regular files/directories admitted')
            need(not item.isdir() or item.size == 0, 'directory payload refused')
            yield name, item, payload
            payload.drain()
        padding = (512-item.size % 512) % 512
        need(not any(exact(padding)), 'nonzero tar member padding')

def observe(zip_path, package_name, remaining_ms):
    need(isinstance(remaining_ms, (int, float)) and 0 < remaining_ms <= LIMITS['timeoutMs'], 'shared deadline required')
    deadline = time.monotonic() + remaining_ms / 1000
    def check(): need(time.monotonic() < deadline, 'shared source deadline expired')
    need(safe(package_name), 'safe registered package name required')
    with zipfile.ZipFile(zip_path) as outer:
        kit_members = [x for x in outer.infolist() if x.filename == 'source-kit.json']
        packages = [x for x in outer.infolist() if x.filename == package_name]
        need(len(kit_members) == len(packages) == 1 and kit_members[0].file_size <= LIMITS['metadataBytes'] and packages[0].file_size <= LIMITS['shardBytes'], 'unique bounded registered originals required')
        with outer.open(kit_members[0]) as source:
            kit_raw = source.read(LIMITS['metadataBytes'] + 1)
        need(len(kit_raw) == kit_members[0].file_size, 'kit metadata truncated')
        kit = json.loads(kit_raw)
        need(kit.get('schemaVersion') == 1 and kit.get('status') == 'native-source-materials' and isinstance(kit.get('files'), list) and 0 < len(kit['files']) <= LIMITS['sourceMembers'], 'source kit schema required')
        expected = {}
        for row in kit['files']:
            name = row.get('path')
            need(safe(name) and name not in expected and name != 'source-kit.json' and isinstance(row.get('sizeBytes'), int) and not isinstance(row['sizeBytes'], bool) and 0 <= row['sizeBytes'] <= LIMITS['shardBytes'] and re.fullmatch('[a-f0-9]{64}', row.get('sha256', '')), 'exact source kit file set required')
            expected[name] = row
        need(not any('/'.join(name.split('/')[:i]) in expected for name in expected for i in range(1,len(name.split('/')))), 'source file used as parent directory')
        expected['source-kit.json'] = dict(path='source-kit.json', sizeBytes=len(kit_raw), sha256=hashlib.sha256(kit_raw).hexdigest())
        need(sum(x['sizeBytes'] for x in expected.values()) <= LIMITS['sourceBytes'], 'source domain byte bound')
        source_result = None
        package_seen = set()
        with outer.open(packages[0]) as compressed:
            package_reader = BoundReader(compressed, packages[0].file_size, check)
            with gzip.GzipFile(fileobj=package_reader) as package:
                package_expanded = 0
                for name, member, package_payload in tar_members(package, 2*1024**3, check):
                    if member.isdir(): continue
                    package_expanded += member.size
                    need(package_expanded <= 1024**3, 'package expanded byte bound')
                    if name != 'install/sources/native-source.tar.gz': continue
                    need(source_result is None and member.size <= LIMITS['shardBytes'], 'unique bounded source archive required')
                    source_reader = BoundReader(package_payload, member.size, check)
                    seen, total, index_hash = set(), 0, hashlib.sha256()
                    with gzip.GzipFile(fileobj=source_reader) as sources:
                        for full, item, payload in tar_members(sources, 1024**3, check):
                            if full == 'native-source' and item.isdir(): continue
                            need(full.startswith('native-source/'), 'exact source root required')
                            relative = full[len('native-source/'):]
                            need(safe(relative), 'safe source member required')
                            if item.isdir():
                                need(any(x.startswith(relative + '/') for x in expected), 'unlisted source directory')
                                continue
                            need(relative not in seen and relative in expected, 'exact regular source file set required')
                            row = expected[relative]
                            need(item.size == row['sizeBytes'], 'source file size differs')
                            seen.add(relative)
                            digest, count = hashlib.sha256(), 0
                            for block in iter(lambda: payload.read(LIMITS['rangeBytes']), b''):
                                check(); count += len(block); total += len(block)
                                need(count <= item.size and total <= LIMITS['sourceBytes'], 'source actual byte bound')
                                digest.update(block)
                            need(count == item.size and digest.hexdigest() == row['sha256'], 'source file bytes differ')
                            index_hash.update((relative + '\0' + str(count) + '\0' + digest.hexdigest() + '\n').encode())
                    source_reader.drain()
                    need(seen == set(expected) and source_reader.count == member.size, 'complete declared source archive required')
                    source_result = dict(path='sources/native-source.tar.gz', bytes=member.size, sha256=source_reader.digest.hexdigest(), files=len(seen)-1, sourceBytes=total, observedFileSetSha256=index_hash.hexdigest())
            package_reader.drain()
            need(package_reader.count == packages[0].file_size and source_result, 'complete native package/source originals required')
        check()
        return dict(schemaVersion=1, kind='agentfs-source-original-byte-observation', sourceKitSha256=hashlib.sha256(kit_raw).hexdigest(), packageSha256=package_reader.digest.hexdigest(), source=source_result, toolchain=kit.get('toolchain'), engine=kit.get('engine'))

if __name__ == '__main__':
    need(len(sys.argv) == 4, 'ZIP, registered package member and remaining milliseconds required')
    print(json.dumps(observe(sys.argv[1], sys.argv[2], float(sys.argv[3])), separators=(',', ':')))
