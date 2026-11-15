#!/usr/bin/env python3
"""Central-only single-member projection from an inherited, full-hashed ZIP fd.
No inner archive expansion and no candidate executable/code loading.
"""
import hashlib, json, os, stat, sys, time, zipfile
request = json.load(sys.stdin)
start = time.monotonic()
source = os.fdopen(os.dup(3), 'rb')
before = os.fstat(source.fileno())
assert stat.S_ISREG(before.st_mode) and before.st_nlink == 1
assert before.st_size == request['archiveBytes']
row = request['member']
assert 0 <= row['bytes'] <= 512 * 1024 ** 2
assert len(row['path'].encode()) <= 255
with zipfile.ZipFile(source) as archive:
    matching = [item for item in archive.infolist() if item.filename == row['path']]
    assert len(matching) == 1
    info = matching[0]
    assert info.file_size == row['bytes'] and not info.is_dir() and not info.flag_bits & 1
    mode = info.external_attr >> 16
    assert not stat.S_ISLNK(mode) and (not stat.S_IFMT(mode) or stat.S_ISREG(mode))
    digest = hashlib.sha256()
    total = 0
    destination = os.open(request['destination'], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with archive.open(info) as reader:
            while True:
                assert time.monotonic() - start < request['timeoutMs'] / 1000
                chunk = reader.read(65536)
                if not chunk: break
                total += len(chunk)
                assert total <= row['bytes']
                free = os.statvfs(os.path.dirname(request['destination']))
                assert free.f_bavail * free.f_frsize >= request['freeFloorBytes'] + len(chunk)
                digest.update(chunk)
                offset = 0
                while offset < len(chunk):
                    written = os.write(destination, chunk[offset:])
                    assert written > 0
                    offset += written
        assert total == row['bytes'] and digest.hexdigest() == row['sha256']
        os.fchmod(destination, 0o400)
    finally:
        os.close(destination)
after = os.fstat(source.fileno())
assert (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns, before.st_nlink) == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_nlink)
print(json.dumps({'bytes': total, 'sha256': digest.hexdigest()}))
