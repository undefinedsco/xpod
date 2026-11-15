"""Own actual SDK commands with separate original stdout/stderr and wait receipts."""
import hashlib
import base64
import stat
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts/agentfs-native-ci'))
from supervise import run_checked_stage, run_stage

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

def failed_stage_originals(name,materials,check):
    """Bounded failure transport only; no command replay or successful receipt.

    Metadata and raw snapshots retain their full same-FD SHA/length. Large raw
    streams carry only a marked tail; the enclosing failed BuildKit raw stream
    retains this frame and cannot turn it into an SDK capability.
    """
    if name not in ('source-prepare','fetchcontent-prepare'):raise ValueError('Fixed prepared failure stage required')
    root=Path(materials).resolve(strict=True);prefix='stages/'+name
    roles={'receipt':prefix+'/command.receipt.json','stdout':prefix+'/stdout.raw','stderr':prefix+'/stderr.raw','supervisionReceipt':prefix+'.receipt.json','supervisionRaw':prefix+'.raw.log'}
    records={};nested=[]
    identity=lambda value:(value.st_dev,value.st_ino,value.st_mode,value.st_size,value.st_mtime_ns,value.st_ctime_ns,value.st_nlink)
    def snapshot(relative,metadata=False,excerpt_limit=8192):
        check();path=root/relative
        if path.exists() and path.resolve(strict=True)!=path:raise ValueError('Canonical prepared failure original required')
        if not path.exists():return {'path':relative,'available':False}
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:
            before=os.fstat(fd);maximum=4*1024**2 if metadata else RAW_LIMIT
            if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or before.st_size>maximum or identity(before)!=identity(path.lstat()):raise ValueError('Bounded actual prepared failure original required')
            digest=hashlib.sha256();size=0;tail=bytearray()
            while True:
                check();block=os.read(fd,65536)
                if not block:break
                size+=len(block)
                if size>before.st_size:raise ValueError('Prepared failure original grew')
                digest.update(block);tail.extend(block)
                if len(tail)>excerpt_limit:
                    if excerpt_limit:del tail[:-excerpt_limit]
                    else:tail.clear()
            if size!=before.st_size or identity(before)!=identity(os.fstat(fd)) or identity(before)!=identity(path.lstat()):raise ValueError('Prepared failure original changed')
            return {'path':relative,'available':True,'bytes':size,'sha256':digest.hexdigest(),'identityDecimal':[str(value) for value in identity(before)],'offset':size-len(tail),'excerptBytes':len(tail),'fullBytesIncluded':size==len(tail),'encoding':'base64','data':base64.b64encode(tail).decode('ascii')}
        finally:os.close(fd)
    for role,relative in roles.items():records[role]=snapshot(relative,role in ('receipt','supervisionReceipt'))
    # Follow only the fixed failed FetchContent Git-command layout. This is
    # diagnostic transport, never a recursive copy or a source authority list.
    if name=='fetchcontent-prepare':
        try:
            def directories(path,maximum):
                if not path.exists():return []
                if path.resolve(strict=True)!=path or path.is_symlink():raise ValueError('Canonical failed dependency directory required')
                rows=[];count=0
                with os.scandir(path) as entries:
                    for entry in entries:
                        check();count+=1
                        if count>maximum:raise ValueError('Failed dependency directory count bound')
                        if entry.is_symlink():raise ValueError('Failed dependency directory symlink')
                        if entry.is_dir(follow_symlinks=False):rows.append(Path(entry.path))
                return sorted(rows)
            for dependency in directories(root/'fetchcontent',64):
                if len(nested)>=2:break
                for command in directories(dependency/'git/commands',64):
                    used=len(json.dumps({'originals':records,'nestedGitCommands':nested},sort_keys=True).encode())
                    allowance=min(8192,max(0,(65500-used-4096)*3//4))
                    receipt=snapshot((command/'receipt.json').relative_to(root).as_posix(),True,allowance)
                    if not receipt.get('available') or not receipt.get('fullBytesIncluded'):continue
                    status=json.loads(base64.b64decode(receipt['data']))
                    if status.get('exit')==0 and status.get('signal') is None:continue
                    if len(nested)>=2:break
                    row={'receipt':receipt}
                    for role in ('stdout','stderr'):
                        used=len(json.dumps({'originals':records,'nestedGitCommands':nested,'next':row},sort_keys=True).encode())
                        allowance=min(8192,max(0,(65500-used-4096)*3//4));row[role]=snapshot((command/(role+'.original')).relative_to(root).as_posix(),False,allowance)
                    nested.append(row)
        except Exception as error:
            records['nestedGitDiagnosticUnavailable']={'errorType':type(error).__name__}
    value={'schemaVersion':1,'kind':'sdk-prepared-failed-stage-originals','stage':roles['receipt'].split('/')[1],'scope':'actual failed original snapshots only; no inferred successful wait or SDK qualification','originals':records,'nestedGitCommands':nested}
    encoded=json.dumps(value,sort_keys=True,separators=(',',':'))
    if len(encoded.encode())>65500:raise ValueError('Prepared failure diagnostic encoded bound')
    check();return value

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
    return _capture(name,command,materials,cwd,inputs,outputs,timeout,resource_profile,False)

def capture_gpgv(name,keyring,inrelease,materials,cwd,timeout=30):
    # Only this fixed command may retain exit 2. Classification belongs to the
    # outer controller's unique Debian signature policy, never this producer.
    command=['gpgv','--status-fd','1','--keyring',str(keyring),str(inrelease)]
    return _capture(name,command,materials,cwd,(),(),timeout,'observation',True)

def _capture(name,command,materials,cwd,inputs,outputs,timeout,resource_profile,unclassified_gpgv):
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
    supervise=run_stage if unclassified_gpgv else run_checked_stage
    receipt,raw=supervise(name,[sys.executable,'-B',str(Path(__file__).resolve()),'--exec-child',str(directory),json.dumps(command)],
        stages,cwd,timeout=timeout,environment=env,free=guarded_free,fresh_bytes=fresh,stop_bytes=stop,poll_seconds=.1,target=directory)
    actual=json.loads((directory/'command.receipt.json').read_text())
    allowed=(0,2) if unclassified_gpgv else (0,)
    if (receipt['exit'] not in allowed or receipt['signal'] is not None or receipt['resourceStop']
            or receipt.get('supervisorError') or receipt.get('cleanupErrors')
            or receipt.get('actualWait') is not True or receipt.get('rawClosedBeforeHash') is not True
            or receipt.get('ownedGroupAbsentAfterWait') is not True or raw is None):
        raise ValueError('SDK supervised command did not close with permitted actual status')
    if actual['exit']!=receipt['exit'] or actual['exit'] not in allowed or actual['actualWait'] is not True or actual['signal'] is not None or actual['pgid']!=receipt['pgid']:
        raise ValueError('SDK actual command execution mismatch')
    for stream in ['stdout','stderr']:
        if ref(directory/actual[stream]['path'],directory)!=actual[stream]:raise ValueError('SDK closed raw original changed')
    for expected in inputs:
        if ref(materials/expected['path'],materials)!=expected:raise ValueError('SDK stage input mutated')
    return dict(**({'classification':'unclassified-producer-gpgv-originals'} if unclassified_gpgv else {}),name=name,receipt=ref(directory/'command.receipt.json',materials),stdout=ref(directory/'stdout.raw',materials),
                stderr=ref(directory/'stderr.raw',materials),supervisionReceipt=ref(stages/(name+'.receipt.json'),materials),
                supervisionRaw=ref(stages/(name+'.raw.log'),materials),inputs=list(inputs),outputs=[ref(path,materials) for path in outputs])

if __name__=='__main__':
    if len(sys.argv)!=4 or sys.argv[1]!='--exec-child':raise SystemExit('Private SDK child protocol required')
    exec_child(json.loads(sys.argv[3]),sys.argv[2])
