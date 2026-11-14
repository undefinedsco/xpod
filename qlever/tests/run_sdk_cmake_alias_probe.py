"""Queued actual CMake configure, whole build domain; diagnostic, never authority."""
import importlib.util
import json
from pathlib import Path
import sys
import time
ROOT=Path(__file__).resolve().parents[2]
LIMITS=dict(sourceMaterialBytes=128*1024**2,shardBytes=64*1024**2)
spec=importlib.util.spec_from_file_location('prepared_cleanup',ROOT/'qlever/tests/run_sdk_prepared_input_probe.py');shared=importlib.util.module_from_spec(spec);spec.loader.exec_module(shared)
def run(destination):
    out=Path(destination);out.mkdir(parents=True,exist_ok=False);build=out/'build';build.mkdir();originals=out/'originals';originals.mkdir()
    source=ROOT/'qlever/tests/fixtures/sdk-cmake-all-inputs';mounts=Path('/proc/self/mountinfo').read_bytes()
    shared.backend.probe.readonly(source,mounts);shared.backend.probe.readonly('/usr/bin/cmake',mounts)
    (out/'mountinfo.original.raw').write_bytes(mounts)
    observer=shared.backend.Observer(originals,source,build,deadline_monotonic=time.monotonic()+90,maximum_bytes=LIMITS['sourceMaterialBytes'],maximum_file_bytes=LIMITS['shardBytes'],selected_names=None)
    result={'scope':'actual whole-build configure diagnostic only; no source or SDK authority'}
    try:
        phase=observer.phase('configure',['/usr/bin/cmake','-S',str(source),'-B',str(build)],cwd=str(source),env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'})
        def reader(name,maximum):
            with (originals/name).open('rb') as stream:
                count=0
                while True:
                    block=stream.read(65536)
                    if not block:break
                    count+=len(block);assert count<=maximum;yield block
        report=shared.backend.bindings.observe([('configure',(line for path in sorted(originals.glob('configure*jsonl')) for line in path.open('rb')))],reader,{},limits=LIMITS)
        result.update(actualPhase=phase,conflictObserved=False,observedEmptyReadEofWindows=report['observedEmptyReadEofWindows'],overallSdkSourceVerified=False)
    except BaseException as error:
        result.update(errorType=type(error).__name__,error=str(error))
        # Inspect actual registered raw rows, not a guessed CMake filename.
        rows=[]
        for path in originals.glob('configure*jsonl'):
            with path.open('rb') as stream:
                for line in stream:
                    assert len(line)<=65536
                    row=json.loads(line)
                    if row.get('kind')=='capture-writable-alias-conflict':rows.append(row)
        result['actualConflicts']=rows;result['conflictObserved']=bool(rows)
        if not rows:raise
    finally:
        (out/'before-cleanup.observation.json').write_text(json.dumps(result,indent=2)+'\n')
        result['cleanup']=shared.close_actual(observer,out/'cleanup.actual.jsonl')
        (out/'observation.json').write_text(json.dumps(result,indent=2)+'\n')
if __name__=='__main__':run(sys.argv[1])
