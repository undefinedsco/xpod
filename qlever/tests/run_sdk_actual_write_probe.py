"""Queued actual sparse/partial write and own-RW read boundary, same backend."""
import importlib.util
import json
from pathlib import Path
import sys
import time
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('write_cleanup',ROOT/'qlever/tests/run_sdk_prepared_input_probe.py');shared=importlib.util.module_from_spec(spec);spec.loader.exec_module(shared)
class ChangedRead(shared.backend.Observer):
    def capture(self,pid,fd,role):
        if role=='consumer':
            path=shared.backend.fdpath(pid,fd)
            if Path(path).stat().st_size:Path(path).write_bytes(b'tampered-before-read')
        return super().capture(pid,fd,role)
class ChangedWrite(shared.backend.Observer):
    def capture_write(self,pid,fd):
        row=super().capture_write(pid,fd);Path(row['path']).write_bytes(b'changed-before-write');return row

def run(destination):
    out=Path(destination);out.mkdir(parents=True,exist_ok=False);results={}
    for name,kind,second in [('sparse-positive',shared.backend.Observer,False),('read-tamper',ChangedRead,False),('write-tamper',ChangedWrite,False),('multiwriter',shared.backend.Observer,True)]:
        case=out/name;case.mkdir();build=case/'build';build.mkdir();originals=case/'originals';originals.mkdir()
        observer=kind(originals,ROOT,build,deadline_monotonic=time.monotonic()+20,maximum_bytes=32*1024**2,maximum_file_bytes=1024**2,selected_names=None)
        code='import os,sys; f=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600); '+('g=os.open(sys.argv[1],os.O_RDWR); ' if second else '')+'os.lseek(f,1144,0); os.write(f,b"x"*155); os.lseek(f,0,0); data=os.read(f,4096); assert data==bytes(1144)+b"x"*155; os.close(f)'
        result={}
        try:
            phase=observer.phase('configure',['/usr/bin/python3','-c',code,str(build/'temporary.o')],cwd=str(ROOT),env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'})
            assert name=='sparse-positive','negative unexpectedly succeeded'
            report=shared.backend.bindings.observe([('configure',(line for path in sorted(originals.glob('configure*jsonl')) for line in path.open('rb')))],lambda name,maximum:(originals/name).read_bytes(),{})
            assert report['observedActualWriteTransitions']==1 and len(report['outputs'])==1 and report['outputs'][0]['bytes']==1299 and report['outputs'][0]['origin']=='actual-exclusive-write-transition'
            result=dict(actualPhase=phase,report=report)
        except BaseException as error:
            result=dict(errorType=type(error).__name__,error=str(error))
            expected={'read-tamper':'lacks actual write transition','write-tamper':'post-write','multiwriter':'another writable FD'}
            if name not in expected or expected[name] not in str(error):raise
        finally:
            (case/'before-cleanup.observation.json').write_text(json.dumps(result,indent=2)+'\n');result['cleanup']=shared.close_actual(observer,case/'cleanup.actual.jsonl');(case/'observation.json').write_text(json.dumps(result,indent=2)+'\n')
        results[name]=result
    (out/'summary.json').write_text(json.dumps(dict(cases=results,overallSdkSourceVerified=False),indent=2)+'\n')
if __name__=='__main__':run(sys.argv[1])
