"""Fixed PID1 release gate for the independently inspected readonly executor."""
import importlib.util
import json
import os
import re
import stat
from pathlib import Path
import time
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('readonly_owned_guard',HERE/'sdk-subreaper-guard.py');guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)
def read_original(path,maximum,end):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    def ident(v):return (v.st_dev,v.st_ino,v.st_size,v.st_mode,v.st_mtime_ns,v.st_ctime_ns)
    try:
        first=os.fstat(fd)
        if not stat.S_ISREG(first.st_mode) or first.st_nlink!=1 or first.st_size>maximum:raise RuntimeError('Bounded single release/preparation original required')
        data=bytearray()
        while True:
            if time.monotonic()>=end:raise TimeoutError('Readonly gate same parent deadline')
            part=os.read(fd,min(65536,first.st_size+1-len(data)))
            if not part:break
            data.extend(part)
            if len(data)>first.st_size:raise RuntimeError('Readonly gate original grew')
        if len(data)!=first.st_size or ident(first)!=ident(os.fstat(fd)) or ident(first)!=ident(Path(path).lstat()):raise RuntimeError('Readonly gate original identity changed')
        return bytes(data)
    finally:os.close(fd)
def main():
    if os.getpid()!=1:raise RuntimeError('Readonly SDK executor must be actual namespace PID1')
    end=float(os.environ['XPOD_QLEVER_SDK_DEADLINE_UNIX']);identity=json.loads(os.environ['XPOD_QLEVER_SDK_IDENTITY']);out=Path('/opt/qlever-sdk/materials')
    monotonic_end=time.monotonic()+max(0,end-time.time())
    prepared=json.loads(read_original(out/'source-prepared.json',4*1024**2,monotonic_end))
    if prepared['identity']!=identity or prepared['deadlineUnix']!=end:raise RuntimeError('Prepared exact source/deadline differs')
    nonce=os.environ['XPOD_QLEVER_EXECUTOR_NONCE']
    if re.fullmatch('[a-f0-9]{64}',nonce) is None:raise RuntimeError('Fixed controller nonce required')
    ready=out/'readonly-executor.ready.json'
    with ready.open('x') as raw:json.dump(dict(pid=os.getpid(),nonce=nonce,identity=identity,deadlineUnix=end),raw);raw.flush();os.fsync(raw.fileno())
    release=out/'readonly-executor.release'
    # Docker create auto-initializes a NEW dedicated volume from the prepared
    # image. A pre-existing release may never bypass outside initial capture.
    if release.exists():raise RuntimeError('Readonly executor release already exists')
    while not release.exists():
        if time.monotonic()>=monotonic_end-30:raise TimeoutError('Readonly executor release deadline')
        time.sleep(.01)
    if read_original(release,65,monotonic_end)!=(nonce+'\n').encode():raise RuntimeError('Fixed controller release original differs')
    return guard.run(['/usr/bin/python3','-B',str(HERE/'sdk-inner-materials.py'),'build'],out/'owner-build.guard.json',end,emit_receipt=True)
if __name__=='__main__':raise SystemExit(main())
