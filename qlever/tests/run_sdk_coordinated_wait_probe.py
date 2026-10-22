"""Linux native mechanics probe. Fixed SDK build/source qualification is separate.

Run in an isolated container with an empty /opt/qlever-sdk/build and read-only
/opt/qlever-sdk/source. The destination must be a new private output directory.
"""
import copy,hashlib,importlib.util,json,os,re,subprocess,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
shared=load('coordinated_probe_cleanup',ROOT/'qlever/tests/run_sdk_prepared_input_probe.py')
backend=shared.backend

def run(destination):
 out=Path(destination);out.mkdir(parents=True,exist_ok=False)
 build=Path('/opt/qlever-sdk/build');assert build.is_dir() and not any(build.iterdir()),'isolated empty canonical build root required'
 source=ROOT/'qlever/tests/fixtures/coordinated-wait.c';binary=out/'actual-coordinated-probe'
 command=['/usr/bin/cc','-std=c11','-O2','-pthread','-Wall','-Wextra','-Werror',str(source),'-o',str(binary)]
 compiled=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30,check=False)
 (out/'compile.stdout.raw').write_bytes(compiled.stdout);(out/'compile.stderr.raw').write_bytes(compiled.stderr)
 assert compiled.returncode==0,'actual native fixture compilation failed'
 originals=out/'originals';originals.mkdir()
 observer=backend.SdkExecutionObserver(originals,'/opt/qlever-sdk/source',build,deadline_monotonic=time.monotonic()+30,check_budget=lambda:None,maximum_bytes=512*1024**2,maximum_stdio_bytes=1024**2)
 result=dict(qualification=False,scope='native coordinated wait mechanics, not the fixed SDK configure/build command',compileCommand=command,sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest(),binarySha256=hashlib.sha256(binary.read_bytes()).hexdigest())
 try:
  phase=backend.Observer.phase(observer,'configure',[str(binary)],cwd='/opt/qlever-sdk/source',env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'})
  assert phase['trackingReceipt']['actualRootReturnCode']==0 and phase['trackingReceipt']['trackedProcessesClosed']
  stdout=json.loads((originals/'configure.stdout.raw').read_text());assert stdout['waited']==0 and stdout['woken']==1 and stdout['value']==66
  raw=b''.join(Path(ref['path']).read_bytes() for ref in phase['rawTraceShards']);rows=[json.loads(line) for line in raw.splitlines()]
  refs={Path(ref['path']).name:ref for ref in phase['captureFiles']}
  def read_original(name,maximum):
   assert re.fullmatch(r'capture-[0-9]{4,8}\.original',name) and name in refs
   reference=refs[name];path=Path(reference['path']);assert path.parent==observer.capture_dir and reference['bytes']<=maximum
   with path.open('rb') as stream:
    while True:
     block=stream.read(65536)
     if not block:break
     yield block
  limits=dict(sourceMaterialBytes=512*1024**2,shardBytes=16*1024**2)
  def replay(values):return backend.bindings.observe([('configure',[(json.dumps(row)+'\n').encode() for row in values])],read_original,{},limits=limits)
  report=replay(rows);assert report['overallSdkSourceVerified']is False and len(report['verifiedCoordinatedWaitIntervals'])==1 and not report['verifiedPrivateWaitMismatchEntrySequences']
  assert any(row['kind']=='generated-vma-write-origin-transition' for row in rows),'actual post-unmap write bridge missing'
  window=next(i for i,row in enumerate(rows)if row['kind']=='generated-kernel-wait-window');closed=next(i for i,row in enumerate(rows)if row['kind']=='generated-kernel-wait-closed');resume=next(i for i,row in enumerate(rows)if row['kind']=='generated-kernel-wait-peer-resume');stop=next(i for i,row in enumerate(rows)if row['kind']=='generated-kernel-wait-peer-stopped')
  mutations={
   'foreign-peer':lambda values:values[resume].update(pid=9999),
   'injected-signal':lambda values:values[resume].update(signal=18),
   'wrong-epoch':lambda values:values[window].update(epochSequence=1),
   'forged-interrupt':lambda values:values[stop].update(waitStatus=34175),
   'wrong-closure':lambda values:values[closed].update(wakeEntrySequence=1),
  }
  refused={}
  for name,mutate in mutations.items():
   changed=copy.deepcopy(rows);mutate(changed)
   try:replay(changed)
   except (ValueError,KeyError,AssertionError,TypeError,StopIteration) as error:refused[name]=str(error)
   else:raise AssertionError('accepted altered native trace: '+name)
  result.update(actualPhase=phase,nativeStdout=stdout,report=report,refusals=refused)
 finally:
  result['cleanup']=shared.close_actual(observer,out/'cleanup.actual.jsonl')
  (out/'observation.json').write_text(json.dumps(result,indent=2)+'\n')
if __name__=='__main__':run(sys.argv[1])
