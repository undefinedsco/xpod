"""Single-backend actual TID/FD-table windows; nonleader exec remains refused."""
import importlib.util
import json
from pathlib import Path
import sys
import time
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('shared_task_cleanup',ROOT/'qlever/tests/run_sdk_prepared_input_probe.py');shared=importlib.util.module_from_spec(spec);spec.loader.exec_module(shared)
CODES={
 'thread-producer':'''import os,sys,threading
p=sys.argv[1]
def work():
 f=os.open(p,os.O_CREAT|os.O_WRONLY,0o600);os.write(f,b'actual-thread-input');os.close(f)
t=threading.Thread(target=work);t.start();t.join();f=os.open(p,os.O_RDONLY);assert os.read(f,100)==b'actual-thread-input';os.close(f)
''',
 'shared-slot':'''import os,sys,threading
f=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600);d=os.dup(f);os.close(d)
t=threading.Thread(target=lambda:os.write(f,b'actual-shared-slot'));t.start();t.join();os.lseek(f,0,0);assert os.read(f,100)==b'actual-shared-slot';os.close(f)
''',
 'fcntl-alias-rejected':'''import os,sys,threading,fcntl
f=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600);d=fcntl.fcntl(f,fcntl.F_DUPFD,20)
t=threading.Thread(target=lambda:os.write(f,b'must-not-pass'));t.start();t.join()
''',
 'leader-exec':'''import os,threading
ready=threading.Event();block=threading.Event()
def work():ready.set();block.wait()
t=threading.Thread(target=work);t.start();ready.wait();os.execve('/usr/bin/true',['true'],{'PATH':'/usr/bin:/bin','LANG':'C'})
''',
 'nonleader-exec-rejected':'''import os,threading
t=threading.Thread(target=lambda:os.execve('/usr/bin/true',['true'],{'PATH':'/usr/bin:/bin','LANG':'C'}));t.start();t.join()
''',
 'process-shared-files':'''import ctypes,os,sys,platform
f=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600);lib=ctypes.CDLL(None,use_errno=True);lib.syscall.restype=ctypes.c_long
nr={'x86_64':56,'aarch64':220}[platform.machine()];pid=lib.syscall(ctypes.c_long(nr),ctypes.c_ulong(0x400|17),ctypes.c_void_p(0),ctypes.c_void_p(0),ctypes.c_void_p(0),ctypes.c_void_p(0));assert pid>=0
if pid==0:os.write(f,b'actual-process-shared-table');os._exit(0)
assert os.waitpid(pid,0)[1]==0;os.lseek(f,0,0);assert os.read(f,100)==b'actual-process-shared-table';os.close(f)
''',
}
def run(destination):
 out=Path(destination);out.mkdir(parents=True,exist_ok=False);results={}
 for name,code in CODES.items():
  case=out/name;case.mkdir();originals=case/'originals';originals.mkdir();build=case/'build';build.mkdir();observer=shared.backend.Observer(originals,ROOT,build,deadline_monotonic=time.monotonic()+30,maximum_bytes=64*1024**2,maximum_file_bytes=1024**2,selected_names=None,shared_tasks=True);result={}
  try:
   phase=observer.phase('configure',['/usr/bin/python3','-c',code,str(build/'output.original')],cwd=str(ROOT),env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'})
   report=shared.backend.bindings.observe([('configure',(line for path in sorted(originals.glob('configure*jsonl')) for line in path.open('rb')))],lambda name,maximum:(originals/name).read_bytes(),{},limits=dict(sourceMaterialBytes=64*1024**2,shardBytes=1024**2))
   assert not name.endswith('rejected'),'negative unexpectedly succeeded';result=dict(actualPhase=phase,report=report,overallSdkSourceVerified=False)
   if name!='leader-exec':assert report['outputs'],'actual shared-task byte relation missing'
  except BaseException as error:
   result.update(errorType=type(error).__name__,error=str(error))
   expected={'fcntl-alias-rejected':'another writable FD','nonleader-exec-rejected':'nonleader exec TID replacement unsupported'}
   if name not in expected or expected[name] not in str(error):raise
  finally:
   (case/'before-cleanup.observation.json').write_text(json.dumps(result,indent=2)+'\n');result['cleanup']=shared.close_actual(observer,case/'cleanup.actual.jsonl');(case/'observation.json').write_text(json.dumps(result,indent=2)+'\n')
  results[name]=result
 (out/'summary.json').write_text(json.dumps(dict(cases=results,overallSdkSourceVerified=False,nonleaderExecSupported=False),indent=2)+'\n')
if __name__=='__main__':run(sys.argv[1])
