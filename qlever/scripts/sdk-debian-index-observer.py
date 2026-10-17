"""Fixed controller-only ZIP reader. Never executes ZIP members or gpgv."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import struct
import sys
import time
import zipfile

spec = importlib.util.spec_from_file_location('index_mechanics', Path(__file__).with_name('sdk-debian-index-bindings.py'))
mechanics = importlib.util.module_from_spec(spec); spec.loader.exec_module(mechanics)
LIMITS = mechanics.LIMITS


def observe(archive_path, plan):
    need = mechanics.need
    remaining = plan['remainingMilliseconds']
    need(isinstance(remaining, (int, float)) and 0 < remaining <= LIMITS['timeoutMs'], 'fixed remaining observation window required')
    deadline = time.monotonic() + remaining / 1000
    def check():
        need(time.monotonic() < deadline, 'SDK index observation deadline')
    def identity(value):
        return value.st_dev, value.st_ino, value.st_size, value.st_mode, value.st_mtime_ns, value.st_ctime_ns
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(archive_path, flags)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and identity(os.lstat(archive_path)) == identity(before), 'retained SDK ZIP identity required')
        # ZipFile reads its central directory eagerly. Bound that small metadata
        # before constructing it; ZIP64 SDK archives must not imply full buffering.
        def at(offset, length):
            need(0 <= offset <= before.st_size and 0 <= length <= LIMITS['metadataBytes'] and offset + length <= before.st_size, 'ZIP metadata range bound')
            result = bytearray()
            while len(result) < length:
                check(); block = os.pread(fd, min(LIMITS['rangeBytes'], length - len(result)), offset + len(result))
                need(block, 'truncated ZIP metadata'); result.extend(block)
            return bytes(result)
        start = max(0, before.st_size - 65557); tail = at(start, before.st_size - start)
        end = tail.rfind(b'PK\x05\x06')
        need(end >= 0 and len(tail) - end >= 22, 'ZIP end record required')
        _, disk, directory_disk, entries_disk, entries, directory_bytes, directory_offset, comment = struct.unpack_from('<4s4H2LH', tail, end)
        need(disk == directory_disk == 0 and end + 22 + comment == len(tail), 'single exact SDK ZIP end record required')
        directory_end = start + end
        if entries == 65535 or directory_bytes == 0xffffffff or directory_offset == 0xffffffff:
            locator = at(directory_end - 20, 20)
            magic, disk64, offset64, disks64 = struct.unpack('<4sLQL', locator)
            need(magic == b'PK\x06\x07' and disk64 == 0 and disks64 == 1, 'single ZIP64 locator required')
            record = struct.unpack('<4sQ2H2L4Q', at(offset64, 56))
            need(record[0] == b'PK\x06\x06' and record[1] == 44 and record[4] == record[5] == 0 and record[6] == record[7], 'canonical single SDK ZIP64 record required')
            entries = record[7]; directory_bytes = record[8]; directory_offset = record[9]; directory_end = offset64
        else:
            need(entries_disk == entries, 'single SDK ZIP directory required')
        need(entries <= LIMITS['members'] and directory_bytes <= LIMITS['metadataBytes'] and directory_offset + directory_bytes == directory_end, 'bounded exact SDK central directory required')
        with os.fdopen(os.dup(fd), 'rb') as stream, zipfile.ZipFile(stream) as archive:
            infos = archive.infolist()
            need(len(infos) <= LIMITS['members'], 'bounded SDK ZIP member count')
            def member(reference):
                check(); name = reference['path']
                need(mechanics.safe(name) and name.startswith('inner/debian-source/indexes/'), 'registered index original prefix required')
                rows = [info for info in infos if info.filename == name]
                need(len(rows) == 1 and rows[0].file_size == reference['bytes'] and 0 <= reference['bytes'] <= LIMITS['shardBytes'], 'exact ZIP index member required')
                need(not rows[0].is_dir() and stat.S_IFMT(rows[0].external_attr >> 16) in (0, stat.S_IFREG), 'regular ZIP index original required')
                return archive.open(rows[0])
            release = plan['inRelease']
            need(release['bytes'] <= LIMITS['metadataBytes'], 'small InRelease original required')
            with member(release) as original:
                data = original.read(LIMITS['metadataBytes'] + 1)
                need(len(data) == release['bytes'] and hashlib.sha256(data).hexdigest() == release['sha256'], 'actual InRelease original bytes differ')
            source = plan['sources']; actual = hashlib.sha256(); count = 0
            with member(source) as original:
                def chunks():
                    nonlocal count
                    while True:
                        check(); block = original.read(LIMITS['rangeBytes'])
                        if not block: break
                        count += len(block); need(count <= source['bytes'], 'Sources original growth'); actual.update(block); yield block
                result = mechanics.verify_sources_checksum_link(data, chunks(), plan['packages'], check_budget=check, require_all_packages=False)
            need(count == source['bytes'] and actual.hexdigest() == source['sha256'], 'actual registered Sources original bytes differ')
        check(); need(identity(os.fstat(fd)) == identity(before) and identity(os.lstat(archive_path)) == identity(before), 'SDK ZIP changed during index observation')
        return result
    finally:
        os.close(fd)


if __name__ == '__main__':
    if len(sys.argv) != 2: raise SystemExit('Fixed SDK ZIP path required')
    raw = sys.stdin.buffer.read(LIMITS['metadataBytes'] + 1)
    mechanics.need(len(raw) <= LIMITS['metadataBytes'], 'bounded controller index plan required')
    print(json.dumps(observe(sys.argv[1], json.loads(raw)), separators=(',', ':')))
