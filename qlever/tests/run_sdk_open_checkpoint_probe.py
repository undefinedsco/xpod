"""Queued one-backend no-byte open versus actual consume/truncate/reuse."""
import importlib.util,json,os,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
s=importlib.util.spec_from_file_location('open_checkpoint_cleanup',ROOT/'qlever/tests/run_sdk_prepared_input_probe.py');shared=importlib.util.module_from_spec(s);s.loader.exec_module(shared);b=shared.backend
CODES={
 'readonly-open-no-consume':'''import os,sys
f=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600)
for i in range(128):
 os.write(f,bytes([i])*4096)
 try:os.open(sys.argv[1]+'.absent',os.O_RDONLY|os.O_CLOEXEC)
 except FileNotFoundError:pass
os._exit(0)
''',
 'readonly-open-read-rejected':'''import os,sys
f=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600);os.write(f,b'actual-content');r=os.open(sys.argv[1],os.O_RDONLY);os.read(r,100)
''',
 'truncate-checkpoint':'''import os,sys
f=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600);os.write(f,b'actual-pretruncate');g=os.open(sys.argv[1],os.O_WRONLY|os.O_TRUNC);os.close(g);os.close(f)
''',
 'closed-fd-reuse':'''import os,sys
f=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600);os.write(f,b'first');os.close(f);g=os.open(sys.argv[1]+'.new',os.O_CREAT|os.O_RDWR,0o600);assert f==g;os.write(g,b'second');os.lseek(g,0,0);assert os.read(g,100)==b'second';os.close(g)
'''}
def run(destination):
 out=Path(destination);out.mkdir(parents=True,exist_ok=False);summary={}
 for name,code in CODES.items():
  case=out/name;case.mkdir();build=case/'build';build.mkdir();originals=case/'originals';originals.mkdir();observer=b.Observer(originals,ROOT,build,deadline_monotonic=time.monotonic()+30,maximum_bytes=16*1024**2,maximum_file_bytes=2*1024**2,selected_names=None,shared_tasks=True);result=dict(overallSdkSourceVerified=False)
  try:
   phase=observer.phase('configure',['/usr/bin/python3','-c',code,str(build/'actual.original')],cwd=str(ROOT),env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'});result['actualPhase']=phase;assert name!='readonly-open-read-rejected','another writer was accepted'
   captures={Path(ref['path']).name:ref for ref in phase['captureFiles']}
   def reader(name,maximum):
    ref=captures[name];path=Path(ref['path']);assert path.parent==observer.capture_dir and ref['bytes']<=maximum
    with path.open('rb') as stream:
     while True:
      chunk=stream.read(65536)
      if not chunk:break
      yield chunk
   rows=[json.loads(line) for ref in phase['rawTraceShards'] for line in Path(ref['path']).open('rb')];checkpoints=[row for row in rows if row['kind']=='append-full-checkpoint'];report=b.bindings.observe([('configure',[(json.dumps(row)+'\n').encode() for row in rows])],reader,{},limits=dict(sourceMaterialBytes=16*1024**2,shardBytes=2*1024**2));result.update(report=report,checkpoints=checkpoints)
   if name=='readonly-open-no-consume':assert len(checkpoints)==1 and checkpoints[0]['reason']=='phase-final' and checkpoints[0]['closedTrackedWaits'] is True and report['outputs']==[]
   elif name=='truncate-checkpoint':
    trunc=next(row for row in rows if row['kind']=='kernel-syscall' and row.get('op')=='entry' and row['nr'] in ([2,257] if row['arch']==0xc000003e else [56]) and row['args'][1 if row['nr']==2 else 2]&512)
    cp=next(row for row in checkpoints if row['entrySequence']==trunc['sequence']);exit=next(row for row in rows if row['kind']=='kernel-syscall' and row.get('op')=='exit' and row.get('entrySequence')==trunc['sequence']);assert cp['sequence']<exit['sequence'] and cp['original']['bytes']==18 and report['outputs']==[]
   elif name=='closed-fd-reuse':assert len(report['outputs'])==1 and report['outputs'][0]['path'].endswith('.new') and report['outputs'][0]['bytes']==6
  except BaseException as error:
   result.update(errorType=type(error).__name__,error=str(error))
   if name!='readonly-open-read-rejected' or 'live writable alias before consumer' not in str(error):raise
   # Actual read is never resumed with a writable alias; checkpoint still
   # sealed the append bytes before that rejected input attempt.
   rows=[json.loads(line) for path in originals.glob('configure*.jsonl') for line in path.open('rb')];cp=next(row for row in rows if row['kind']=='append-full-checkpoint');conflict=next(row for row in rows if row['kind']=='capture-writable-alias-conflict');assert cp['sequence']<conflict['sequence'];result.update(checkpoints=[cp],actualReadRejectedBeforeResume=True)
  finally:
   (case/'before-cleanup.observation.json').write_text(json.dumps(result,indent=2)+'\n');result['cleanup']=shared.close_actual(observer,case/'cleanup.actual.jsonl');(case/'observation.json').write_text(json.dumps(result,indent=2)+'\n');summary[name]=result
 (out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
if __name__=='__main__':run(sys.argv[1])
