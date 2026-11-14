"""Fixed same-backend stopped-FD provider probe, never SDK/source admission."""
import copy
import hashlib
import importlib.util
import json
import math
import os
import re
import stat
from pathlib import Path
import sys
import time
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('provider_probe_backend',ROOT/'qlever/scripts/sdk-ptrace-execution.py');backend=importlib.util.module_from_spec(spec);spec.loader.exec_module(backend)
LIMITS=json.loads((ROOT/'scripts/lib/module-artifact-limits.json').read_text())
def close_actual(observer,path,end,reserve_bytes):
    waits=[];known=set(observer.tasks);raw=None;logging_error=None
    # Even a retained-budget or log-open error must not leave the owned child
    # at a ptrace exit-stop. Logging failure never becomes successful evidence.
    observer.abort()
    try:
        try:raw=path.open('xb')
        except BaseException as error:logging_error=error
        def emit(row):
            nonlocal logging_error
            if logging_error is not None:return
            try:
                data=(json.dumps(row,sort_keys=True)+'\n').encode();assert raw.tell()+len(data)<=4*1024**2
                reserve_bytes(len(data));assert raw.write(data)==len(data);raw.flush();os.fsync(raw.fileno())
            except BaseException as error:logging_error=error
        emit(dict(kind='cleanup-start',knownTrackedPids=sorted(known)))
        with backend.owned_wait.BlockingOwnedWait(end,backend.WALL) as waiter:
            while True:
                try:
                    pid,status=waiter.wait_one();assert len(waits)<1024;waits.append(dict(pid=pid,status=status));emit(dict(kind='actual-cleanup-wait',pid=pid,status=status))
                    assert pid in known,'cleanup wait returned an unregistered PID'
                    if os.WIFSTOPPED(status):
                        try:backend.single.trace(7,pid,0,9);emit(dict(kind='actual-cleanup-ptrace-cont',pid=pid,signal=9,event=status>>16))
                        except ProcessLookupError:emit(dict(kind='actual-cleanup-ptrace-cont-esrch',pid=pid))
                    else:assert os.WIFEXITED(status) or os.WIFSIGNALED(status)
                except ChildProcessError:
                    emit(dict(kind='actual-cleanup-echild'))
                    if logging_error is not None:raise logging_error
                    return dict(actualEchild=True,waits=waits)
    finally:
        if raw is not None:raw.close()


NUMERIC=b'import ctypes,errno\nlibc=ctypes.CDLL(None,use_errno=True);libc.syscall.restype=ctypes.c_long\nctypes.set_errno(0);result=libc.syscall(425,256,0,0,0,0,0)\nassert result==-1 and ctypes.get_errno()==errno.ENOSYS\n'
CMAKE=b'cmake_minimum_required(VERSION 3.20)\nproject(ExplicitDenial NONE)\nexecute_process(COMMAND /usr/bin/true COMMAND_ERROR_IS_FATAL ANY)\n'
UID=b"import os,ctypes,platform\nuid=os.geteuid();assert os.getresuid()==(uid,uid,uid)\nnr=147 if platform.machine()=='aarch64' else 117\nlibc=ctypes.CDLL(None,use_errno=True);libc.syscall.restype=ctypes.c_long\nassert libc.syscall(ctypes.c_long(nr),ctypes.c_ulong(-1),ctypes.c_ulong(uid),ctypes.c_ulong(-1))==0\n"
def case_parameters(name,available):
 assert name in ['numeric','cmake-synchronous','uid-noop'] and type(available) is int and available>0,'fixed diagnostic case/shared remaining required'
 uid=name=='uid-noop'
 return dict(maximum_file_bytes=min(8*1024**2 if uid else 1024**2,available),shared_tasks=uid,capture_toolchain=uid,verified_setresuid_noop=uid,deny_optional_io_uring=not uid)
def uid_completion(rows):
 entries=[r for r in rows if r['kind']=='setresuid-noop-entry-original'];exits=[r for r in rows if r['kind']=='setresuid-noop-exit-original']
 assert len(entries)==len(exits)==1,'actual unique UID operation required'
 entry,exit=entries[0],exits[0];indexed={r['sequence']:r for r in rows}
 raw_entry=indexed[entry['entrySequence']];raw_exit=indexed[exit['exitSequence']]
 assert raw_entry['kind']==raw_exit['kind']=='kernel-syscall' and raw_entry['op']=='entry' and raw_exit['op']=='exit'
 assert raw_exit['entrySequence']==entry['entrySequence']==exit['entrySequence'] and raw_exit['result']==0 and raw_exit['isError'] is False
 assert entry['entrySequence']<entry['barrierSequence']<entry['sequence']<exit['exitSequence']<exit['barrierSequence']<exit['sequence']
 for row in [entry,exit]:
  barrier=indexed[row['barrierSequence']];assert barrier['kind']=='all-stop-barrier' and row['pid'] in barrier['pids']
 return dict(actualUidTransitions=1,uidEntrySequence=entry['entrySequence'],uidExitSequence=exit['exitSequence'],architecture=raw_entry['arch'])
def run(destination,identity,deadline,remaining_retained_bytes):
 now=time.time();assert type(deadline) in [int,float] and math.isfinite(deadline) and 0<deadline-now<=120.5
 end=time.monotonic()+min(deadline-now,120);phase_end=end-5
 assert type(remaining_retained_bytes) is int and 4*1024**2<remaining_retained_bytes<=64*1024**2
 out=Path(destination);assert out.is_absolute() and out.parent==Path('/probe-output') and out.name=='run' and not out.exists()
 out.mkdir();summary={};source=out/'fixed-inputs';source.mkdir()
 def check():assert time.monotonic()<end,'same caller diagnostic deadline'
 def used():
  count=0;total=0
  for path in out.rglob('*'):
   check();assert not path.is_symlink()
   if path.is_file():count+=1;assert count<=4096;total+=path.stat().st_size;assert total<=remaining_retained_bytes,'shared probe output retained bound'
  return total
 def reserve(amount):
  check();assert type(amount) is int and amount>=0 and used()+amount<=remaining_retained_bytes,'same shared probe retained bytes before write'
 def save(path,data):
  check();assert isinstance(data,bytes) and len(data)<=4*1024**2 and used()+len(data)<=remaining_retained_bytes
  with path.open('xb') as stream:assert stream.write(data)==len(data);stream.flush();os.fsync(stream.fileno())
 def savejson(path,value):save(path,(json.dumps(value,sort_keys=True)+'\n').encode())
 prepared=Path('/opt/qlever-sdk/materials/source-prepared.json');fd=os.open(prepared,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
 try:
  before=os.fstat(fd);assert stat.S_ISREG(before.st_mode) and before.st_size<=4*1024**2;data=bytearray()
  while True:
   check();block=os.read(fd,65536)
   if not block:break
   data.extend(block);assert len(data)<=before.st_size
  key=lambda v:(v.st_dev,v.st_ino,v.st_mode,v.st_size,v.st_mtime_ns,v.st_ctime_ns,v.st_nlink)
  assert len(data)==before.st_size and key(before)==key(os.fstat(fd))==key(prepared.lstat())
 finally:os.close(fd)
 prepared_data=bytes(data);assert json.loads(prepared_data)['identity']==identity,'same actual prepared source tuple required'
 save(out/'source-prepared.original.json',prepared_data);savejson(out/'diagnostic-scope.original.json',dict(identity=identity,deadlineUnix=deadline,remainingRetainedBytes=remaining_retained_bytes,normalModeEnabled=False,releaseAccepted=False))
 save(source/'numeric.py',NUMERIC);save(source/'CMakeLists.txt',CMAKE);save(source/'own_uid.py',UID)
 # The declared Observer build root and the directory CMake is told to use must be
 # THE SAME directory. Otherwise link metadata for in-build operands is reported as
 # outside the observed root, which made the probe's own fixture produce markers it
 # could never settle. One authority: build_root is computed once, used for both.
 def build_root_for(name):
  return out/name/'build'
 cases=[('numeric',['/usr/bin/python3',str(source/'numeric.py')]),('cmake-synchronous',['/usr/bin/cmake','-S',str(source),'-B',str(build_root_for('cmake-synchronous'))]),('uid-noop',['/usr/bin/python3',str(source/'own_uid.py')])]
 for name,command in cases:
  case=out/name;case.mkdir();originals=case/'originals';originals.mkdir();build=build_root_for(name);build.mkdir();result={}
  assert build==build_root_for(name),'single build root authority'
  available=min(32*1024**2,remaining_retained_bytes-used()-4*1024**2);assert available>0,'same shared probe remaining budget'
  parameters=case_parameters(name,available)
  observer=backend.Observer(originals,source,build,deadline_monotonic=phase_end,maximum_bytes=available,maximum_stdio_bytes=1024**2,maximum_processes=64,selected_names=None,**parameters)
  try:
   phase=observer.phase('configure',command,cwd=str(source),env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'})
   rows=list(backend.probe.decoded_raw_records(line for path in sorted(originals.glob('configure*jsonl')) for line in path.open('rb')))
   denials=[r for r in rows if r['kind']=='explicit-io-uring-setup-denied'];completions=[r for r in rows if r['kind']=='explicit-io-uring-setup-denied-exit']
   def actual_capture(name,maximum):
    assert re.fullmatch(r'capture-[0-9]{4,}\.original',name),'fixed capture original only'
    path=originals/name;fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
     before=os.fstat(fd);identity=lambda v:(v.st_dev,v.st_ino,v.st_mode,v.st_size,v.st_nlink,v.st_mtime_ns,v.st_ctime_ns)
     assert stat.S_ISREG(before.st_mode) and before.st_size<=maximum
     count=0
     while True:
      assert time.monotonic()<end,'same probe deadline'
      block=os.read(fd,65536)
      if not block:break
      count+=len(block);assert count<=before.st_size
      yield block
     assert count==before.st_size and identity(before)==identity(os.fstat(fd))==identity(path.lstat()),'actual capture changed'
    finally:os.close(fd)
   # observe() reads four keys whenever `limits` is truthy, so a partial dict
   # bypasses its per-key defaults. The two budget keys stay CASE-DERIVED (the
   # per-case remaining budget is not the global cap); the two structural keys
   # come from the canonical reviewed LIMITS this module already loads. No new
   # numbers and no .get fallback: a missing canonical key must still fail loudly.
   proof=backend.bindings.observe([('configure',[(json.dumps(r)+'\n').encode() for r in rows])],actual_capture,{},limits={'sourceMaterialBytes':available,'shardBytes':parameters['maximum_file_bytes'],'sourceMembers':LIMITS['sourceMembers'],'metadataBytes':LIMITS['metadataBytes']})
   if name=='uid-noop':specific=uid_completion(rows);architecture=specific.pop('architecture')
   else:
    assert denials and len(denials)==len(completions),'probe did not exercise explicit denial'
    specific=dict(actualDenials=len(denials));architecture=denials[0]['arch']
   assert phase['trackingReceipt']['actualRootReturnCode']==0 and phase['trackingReceipt']['trackedProcessesClosed']
   result=dict(actualPhase=phase,**specific,architecture=architecture,kernel=dict(zip(['sysname','nodename','release','version','machine'],os.uname())),proof=proof,normalModeEnabled=False,overallSdkSourceVerified=False)
  finally:
   try:savejson(case/'before-cleanup.observation.json',result)
   finally:result['cleanup']=close_actual(observer,case/'cleanup.actual.jsonl',end,reserve)
   savejson(case/'observation.json',result)
  summary[name]=result
 savejson(out/'observation.json',summary)
if __name__=='__main__':
 import argparse
 parser=argparse.ArgumentParser();parser.add_argument('destination');parser.add_argument('--identity',required=True);parser.add_argument('--deadline',required=True,type=float);parser.add_argument('--remaining-retained-bytes',required=True,type=int);a=parser.parse_args();run(a.destination,json.loads(a.identity),a.deadline,a.remaining_retained_bytes)
