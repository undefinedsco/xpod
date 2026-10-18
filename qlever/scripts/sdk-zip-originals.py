"""Shared same-FD SDK ZIP metadata and regular-original streaming bounds."""
import contextlib
import json
import os
import re
from pathlib import Path
import stat
import struct
import zipfile
LIMITS=json.loads((Path(__file__).resolve().parents[2]/'scripts/lib/module-artifact-limits.json').read_text())
def need(value,reason):
    if not value:raise ValueError('SDK ZIP originals: '+reason)
def safe(name):
    return isinstance(name,str) and name and not name.startswith('/') and not any(c in name for c in '\\\0\r\n') and all(part not in ('','.','..') for part in name.split('/'))
@contextlib.contextmanager
def registered_zip_originals(archive_path,prefix,check,*,master_reference=None):
    old_prefixes=('inner/debian-source/indexes/','inner/upstream-source/','inner/toolchain-execution/','inner/debian-binary/','inner/fetchcontent/')
    new_mode=prefix=='readonly-executor/' and isinstance(master_reference,dict) and set(master_reference)=={'path','bytes','sha256'} and master_reference.get('path')=='materials.json' and type(master_reference.get('bytes')) is int and 0<master_reference['bytes']<=LIMITS['metadataBytes'] and isinstance(master_reference.get('sha256'),str) and re.fullmatch('[a-f0-9]{64}',master_reference['sha256']) is not None
    need((prefix in old_prefixes and master_reference is None) or new_mode,'fixed SDK original domain/master reference required')
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
                need(safe(name) and (name.startswith(prefix) or (new_mode and ((name=='materials.json' and reference==master_reference) or name=='normal-route.original.json' or name.startswith('daemon-activation/') or name in {('stages/'+stage+suffix) for stage in ['prepare-source-image','compose-linked-image'] for suffix in ['/command.receipt.json','.receipt.json','.raw.log']}))), 'registered index original prefix required')
                rows = [info for info in infos if info.filename == name]
                need(len(rows) == 1 and rows[0].file_size == reference['bytes'] and 0 <= reference['bytes'] <= LIMITS['shardBytes'], 'exact ZIP index member required')
                need(not rows[0].is_dir() and stat.S_IFMT(rows[0].external_attr >> 16) in (0, stat.S_IFREG), 'regular ZIP index original required')
                return archive.open(rows[0])
            member.names = tuple(info.filename for info in infos if not info.is_dir())
            yield member
        check(); need(identity(os.fstat(fd)) == identity(before) and identity(os.lstat(archive_path)) == identity(before), 'SDK ZIP changed during observation')
    finally:
        os.close(fd)
