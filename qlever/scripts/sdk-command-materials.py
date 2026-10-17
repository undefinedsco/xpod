"""Own actual SDK commands with separate original stdout/stderr and wait receipts."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts/agentfs-native-ci'))
from supervise import run_checked_stage

RAW_LIMIT=256*1024**2

def ref(path,root):
    path=Path(path);root=Path(root).resolve(strict=True)
    if path.is_symlink() or not path.is_file():raise ValueError('SDK original must be regular')
    path=path.resolve(strict=True);relative=path.relative_to(root)
    value=hashlib.sha256()
    with path.open('rb') as stream:
        before=os.fstat(stream.fileno())
        for block in iter(lambda:stream.read(65536),b''):value.update(block)
        after=os.fstat(stream.fileno())
    identity=lambda item:(item.st_dev,item.st_ino,item.st_size,item.st_mtime_ns,item.st_mode)
    if identity(before)!=identity(after) or identity(path.lstat())!=identity(after):raise ValueError('SDK original changed while hashing')
    return dict(path=str(relative),bytes=after.st_size,sha256=value.hexdigest())

def exec_child(command,directory):
    directory=Path(directory);start=time.time_ns()
    with (directory/'stdout.raw').open('xb') as stdout,(directory/'stderr.raw').open('xb') as stderr:
        child=subprocess.Popen(command,stdout=stdout,stderr=stderr)
        pid=child.pid;pgid=os.getpgid(pid);code=child.wait()
        stdout.flush();stderr.flush();os.fsync(stdout.fileno());os.fsync(stderr.fileno())
    receipt=dict(schemaVersion=1,command=command,pid=pid,pgid=pgid,actualWait=True,exit=code if code>=0 else None,
                 signal=-code if code<0 else None,startedUnixNs=start,completedUnixNs=time.time_ns(),
                 rawClosedBeforeHash=True,stdout=ref(directory/'stdout.raw',directory),stderr=ref(directory/'stderr.raw',directory))
    (directory/'command.receipt.json').write_text(json.dumps(receipt,sort_keys=True,indent=2)+'\n')
    raise SystemExit(code if code>=0 else 128-code)

def capture(name,command,materials,cwd,inputs=(),outputs=(),timeout=3600,resource_profile='build'):
    if not name or any(char not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for char in name):raise ValueError('Unsafe SDK stage name')
    profiles={'build':(4*1024**3,2*1024**3),'observation':(2304*1024**2,2*1024**3),'cleanup':(256*1024**2,128*1024**2)}
    if resource_profile not in profiles:raise ValueError('Unknown SDK command resource profile')
    fresh,stop=profiles[resource_profile]
    materials=Path(materials).resolve();stages=materials/'stages';stages.mkdir(parents=True,exist_ok=True)
    directory=stages/name;directory.mkdir(mode=0o700)
    for expected in inputs:
        if ref(materials/expected['path'],materials)!=expected:raise ValueError('SDK stage input original changed')
    def guarded_free(path):
        for file in ['stdout.raw','stderr.raw']:
            stream=directory/file
            if stream.exists() and stream.stat().st_size>RAW_LIMIT:raise RuntimeError('SDK original stream budget exceeded')
        return shutil.disk_usage(path)
    env={key:value for key,value in os.environ.items() if key not in ('GH_TOKEN','GITHUB_TOKEN')}
    receipt,_=run_checked_stage(name,[sys.executable,'-B',str(Path(__file__).resolve()),'--exec-child',str(directory),json.dumps(command)],
        stages,cwd,timeout=timeout,environment=env,free=guarded_free,fresh_bytes=fresh,stop_bytes=stop,poll_seconds=.1,target=directory)
    actual=json.loads((directory/'command.receipt.json').read_text())
    if actual['exit']!=0 or actual['signal'] is not None or actual['pgid']!=receipt['pgid']:
        raise ValueError('SDK actual command execution mismatch')
    for stream in ['stdout','stderr']:
        if ref(directory/actual[stream]['path'],directory)!=actual[stream]:raise ValueError('SDK closed raw original changed')
    for expected in inputs:
        if ref(materials/expected['path'],materials)!=expected:raise ValueError('SDK stage input mutated')
    return dict(name=name,receipt=ref(directory/'command.receipt.json',materials),stdout=ref(directory/'stdout.raw',materials),
                stderr=ref(directory/'stderr.raw',materials),supervisionReceipt=ref(stages/(name+'.receipt.json'),materials),
                supervisionRaw=ref(stages/(name+'.raw.log'),materials),inputs=list(inputs),outputs=[ref(path,materials) for path in outputs])

if __name__=='__main__':
    if len(sys.argv)!=4 or sys.argv[1]!='--exec-child':raise SystemExit('Private SDK child protocol required')
    exec_child(json.loads(sys.argv[3]),sys.argv[2])
