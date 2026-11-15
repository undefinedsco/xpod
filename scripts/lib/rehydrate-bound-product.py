#!/usr/bin/env python3
"""Central-only bounded gzip projection from an inherited retained product fd."""
import gzip, hashlib, json, os, stat, sys, time
request=json.load(sys.stdin)
start=time.monotonic();source=os.fdopen(os.dup(3),'rb');before=os.fstat(source.fileno())
assert stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_size==request['packedBytes']
assert 0<=before.st_size<=768*1024**2 and 0<=request['expandedBytes']<=2*1024**3
packed=hashlib.sha256();scratch=65536
while True:
    assert time.monotonic()-start<request['timeoutMs']/1000
    chunk=source.read(scratch)
    if not chunk:break
    packed.update(chunk)
assert packed.hexdigest()==request['packedSha256']
source.seek(0);expanded=0;digest=hashlib.sha256()
fd=os.open(request['destination'],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
try:
    with gzip.GzipFile(fileobj=source) as archive:
        while True:
            assert time.monotonic()-start<request['timeoutMs']/1000
            chunk=archive.read(scratch)
            if not chunk:break
            expanded+=len(chunk);assert expanded<=request['expandedBytes']
            free=os.statvfs(os.path.dirname(request['destination']))
            assert free.f_bavail*free.f_frsize>=request['freeFloorBytes']+len(chunk)
            digest.update(chunk);offset=0
            while offset<len(chunk):
                count=os.write(fd,chunk[offset:]);assert count>0;offset+=count
    assert expanded==request['expandedBytes'] and digest.hexdigest()==request['tarSha256']
    os.fchmod(fd,0o400)
finally:os.close(fd)
after=os.fstat(source.fileno())
assert (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns,before.st_nlink)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns,after.st_nlink)
print(json.dumps({'bytes':expanded,'sha256':digest.hexdigest()}))
