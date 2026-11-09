"""Queued Linux append/checkpoint evidence, one existing all-stop backend."""
import hashlib,importlib.util,json,os,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('append_cleanup',ROOT/'qlever/tests/run_sdk_prepared_input_probe.py');shared=importlib.util.module_from_spec(spec);spec.loader.exec_module(shared);backend=shared.backend
class Counted(backend.Observer):
 def __init__(self,*a,**kw):super().__init__(*a,**kw);self.fullHashBytes=0
 def fd_blocks(self,reader,size):
  self.fullHashBytes+=size
  yield from super().fd_blocks(reader,size)
class PrefixChanged(Counted):
 def checkpoint_appends(self,reason,entry_sequence=None):
  if not getattr(self,'injected',False) and any(c['dirty'] and c['identity'][3]>0 for c in self.append_chains.values()):
   self.injected=True
   # External test mutation happens with all registered tasks stopped. Only
   # test-owned path is touched; actual bytes and inode are retained in output.
   path=self.changed_path;fd=os.open(path,os.O_WRONLY)
   try:os.pwrite(fd,b'!',0);os.fsync(fd)
   finally:os.close(fd)
  return super().checkpoint_appends(reason,entry_sequence)
def run(destination):
 out=Path(destination);out.mkdir(parents=True,exist_ok=False);summaries={}
 base='import os,sys,threading; p=sys.argv[1]; f=os.open(p,os.O_CREAT|os.O_RDWR,0o600); parts=[bytes([i%251])*4096 for i in range(256)]; '
 for name in ['append-read-close','append-overwrite','shared-thread','no-close-phase-checkpoint','prefix-changed-rejected','strict-budget-rejected']:
  case=out/name;case.mkdir();build=case/'build';build.mkdir();originals=case/'originals';originals.mkdir();target=build/'actual-output.original';maximum=16*1024**2 if name!='strict-budget-rejected' else 512*1024
  kind=PrefixChanged if name=='prefix-changed-rejected' else Counted
  observer=kind(originals,ROOT,build,deadline_monotonic=time.monotonic()+30,maximum_bytes=maximum,maximum_file_bytes=2*1024**2,selected_names=None,shared_tasks=True);observer.changed_path=target
  if name=='shared-thread':code=base+'t=threading.Thread(target=lambda:[os.write(f,p) for p in parts]); t.start(); t.join(); os.lseek(f,0,0); assert os.read(f,2*1024**2)==b"".join(parts); os.close(f)'
  elif name=='no-close-phase-checkpoint':code=base+'[os.write(f,p) for p in parts]; os._exit(0)'
  elif name=='append-overwrite':code=base+'[os.write(f,p) for p in parts]; os.lseek(f,9,0); os.write(f,b"XYZ"); os.lseek(f,0,0); assert os.read(f,2*1024**2)==b"".join(parts)[:9]+b"XYZ"+b"".join(parts)[12:]; os.close(f)'
  else:code=base+'[os.write(f,p) for p in parts]; os.lseek(f,0,0); assert os.read(f,2*1024**2)==b"".join(parts); os.close(f)'
  result=dict(overallSdkSourceVerified=False,maximumBytes=maximum)
  try:
   phase=observer.phase('configure',['/usr/bin/python3','-c',code,str(target)],cwd=str(ROOT),env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'});result['actualPhase']=phase
   assert name not in ['prefix-changed-rejected','strict-budget-rejected'],'negative unexpectedly succeeded'
   refs={Path(ref['path']).name:ref for ref in phase['captureFiles']}
   def reader(name,maximum):
    ref=refs[name];path=Path(ref['path']);assert path.parent==observer.capture_dir and ref['bytes']<=maximum
    with path.open('rb') as stream:
     before=backend.probe.identity(os.fstat(stream.fileno()));count=0;digest=hashlib.sha256()
     while True:
      block=stream.read(65536)
      if not block:break
      count+=len(block);digest.update(block);yield block
     assert before==backend.probe.identity(os.fstat(stream.fileno())) and (count,digest.hexdigest())==(ref['bytes'],ref['sha256'])
   lines=[('configure',(line for ref in phase['rawTraceShards'] for line in Path(ref['path']).open('rb')))]
   report=backend.bindings.observe(lines,reader,{},limits=dict(sourceMaterialBytes=maximum,shardBytes=2*1024**2));result.update(report=report,fullHashBytes=observer.fullHashBytes,chargedDomainBytes=observer.domain_bytes)
   # 256 append writes must not each re-hash the growing full file. This is
   # instrumentation, not a timing prediction. Existing checkpoints/captures
   # still retain full actual bytes within the unchanged shared authority.
   assert observer.fullHashBytes<=8*1024**2,'append full hashing remains quadratic'
   if name=='no-close-phase-checkpoint':assert report['outputs']==[],'no close/read must not invent a producer/consumer fact'
   else:assert report['outputs'][0]['bytes']==1024**2
  except BaseException as error:
   result.update(errorType=type(error).__name__,error=str(error),chargedDomainBytes=observer.domain_bytes,fullHashBytes=observer.fullHashBytes)
   if name=='prefix-changed-rejected':assert 'checkpoint FD identity changed' in str(error) or 'prefix changed' in str(error)
   elif name=='strict-budget-rejected':
    assert 'shared execution original byte bound' in str(error)
    transitions=0
    for path in originals.glob('configure*.jsonl'):
     with path.open('rb') as stream:
      for line in stream:
       assert len(line)<=65536
       if json.loads(line)['kind']=='actual-write-transition':transitions+=1
    assert transitions>0,'budget negative must reach actual write effects'
    result['actualWriteTransitionsBeforeBudgetReject']=transitions
   else:raise
  finally:
   (case/'before-cleanup.observation.json').write_text(json.dumps(result,indent=2)+'\n');result['cleanup']=shared.close_actual(observer,case/'cleanup.actual.jsonl');(case/'observation.json').write_text(json.dumps(result,indent=2)+'\n');summaries[name]=result
 (out/'summary.json').write_text(json.dumps(dict(cases=summaries,overallSdkSourceVerified=False),indent=2)+'\n')
if __name__=='__main__':run(sys.argv[1])
