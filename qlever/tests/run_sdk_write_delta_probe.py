"""Queued Linux chunk-write/strict-ledger probe, same production backend."""
import importlib.util
import json
from pathlib import Path
import sys
import time
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('delta_cleanup',ROOT/'qlever/tests/run_sdk_prepared_input_probe.py');shared=importlib.util.module_from_spec(spec);spec.loader.exec_module(shared)
def run(destination):
 out=Path(destination);out.mkdir(parents=True,exist_ok=False)
 for name,maximum in [('linear-positive',8*1024**2),('strict-budget-rejected',512*1024)]:
  case=out/name;case.mkdir();build=case/'build';build.mkdir();originals=case/'originals';originals.mkdir()
  observer=shared.backend.Observer(originals,ROOT,build,deadline_monotonic=time.monotonic()+30,maximum_bytes=maximum,maximum_file_bytes=2*1024**2,selected_names=None,shared_tasks=True)
  code='import os,sys; f=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600); parts=[bytes([i])*32768 for i in range(32)]; [os.write(f,p) for p in parts]; os.lseek(f,0,0); assert os.read(f,2*1024**2)==b"".join(parts); os.close(f)'
  result=dict(overallSdkSourceVerified=False,maximumBytes=maximum)
  try:
   phase=observer.phase('configure',['/usr/bin/python3','-c',code,str(build/'actual-chunk-output.original')],cwd=str(ROOT),env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'})
   result['actualPhase']=phase;assert name=='linear-positive','strict budget unexpectedly succeeded'
   refs={Path(row['path']).name:row for row in phase['captureFiles']}
   def reader(name,maximum):
    row=refs[name];path=Path(row['path']);assert path.parent==observer.capture_dir and path.stat().st_size==row['bytes']<=maximum
    with path.open('rb') as stream:
     while True:
      block=stream.read(65536)
      if not block:break
      yield block
   report=shared.backend.bindings.observe([('configure',(line for row in phase['rawTraceShards'] for line in Path(row['path']).open('rb')))],reader,{},limits=dict(sourceMaterialBytes=maximum,shardBytes=2*1024**2))
   actual=sum(row['bytes'] for row in phase['captureFiles']);assert actual<=4*1024**2,'chunk originals failed linear-size projection';assert len(report['outputs'])==1 and report['outputs'][0]['bytes']==1024**2
   result.update(report=report,captureOriginalBytes=actual,chargedDomainBytes=observer.domain_bytes)
  except BaseException as error:
   result.update(errorType=type(error).__name__,error=str(error),chargedDomainBytes=observer.domain_bytes)
   if name!='strict-budget-rejected' or 'shared execution original byte bound' not in str(error):raise
  finally:
   (case/'before-cleanup.observation.json').write_text(json.dumps(result,indent=2)+'\n');result['cleanup']=shared.close_actual(observer,case/'cleanup.actual.jsonl');(case/'observation.json').write_text(json.dumps(result,indent=2)+'\n')
if __name__=='__main__':run(sys.argv[1])
