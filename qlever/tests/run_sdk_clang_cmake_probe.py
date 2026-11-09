"""Actual Linux Clang/LLD configure/build regression, never SDK qualification.

Mount fixtures/clang-cmake read-only at /opt/qlever-sdk/source, use an empty
/opt/qlever-sdk/build executable tmpfs and a read-only container root. Requires clang-19,
clang++-19, ld.lld-19 and CMake. The destination must be a new private directory.
The normal SDK observer supplies all budgets, tracing and original retention;
these tiny diagnostic commands do not replace the fixed QLever SDK recipe.
"""
import importlib.util,json,subprocess,sys,time,traceback
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('clang_cmake_cleanup',ROOT/'qlever/tests/run_sdk_prepared_input_probe.py');shared=importlib.util.module_from_spec(spec);spec.loader.exec_module(shared);backend=shared.backend

def run(destination,metadata_stress=False):
 out=Path(destination);out.mkdir(parents=True,exist_ok=False)
 build=Path('/opt/qlever-sdk/build');assert build.is_dir()and not any(build.iterdir()),'isolated empty canonical build root required'
 deadline=time.monotonic()+300
 def check():
  if time.monotonic()>=deadline:raise TimeoutError('same native CMake diagnostic parent deadline')
 observer=backend.SdkExecutionObserver(out,'/opt/qlever-sdk/source',build,deadline_monotonic=deadline,check_budget=check,maximum_bytes=4*1024**3,maximum_stdio_bytes=1024**2)
 commands=[('configure',['/usr/bin/cmake','-S','/opt/qlever-sdk/source','-B',str(build),'-DCMAKE_C_COMPILER=clang-19','-DCMAKE_CXX_COMPILER=clang++-19','-DCMAKE_EXE_LINKER_FLAGS=-fuse-ld=/usr/bin/ld.lld-19']),('build',['/usr/bin/cmake','--build',str(build),'--parallel','2'])]
 record=dict(qualification=False,scope='actual tiny CMake/Clang19/LLD configure and build, not fixed QLever SDK recipe',commands=commands,phases=[]);failed=False
 try:
  for name,command in commands:
   phase=backend.Observer.phase(observer,name,command,cwd='/opt/qlever-sdk/source',env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'})
   record['phases'].append(phase);assert phase['trackingReceipt']['actualRootReturnCode']==0 and phase['trackingReceipt']['trackedProcessesClosed']
  refs={Path(ref['path']).name:ref for phase in record['phases']for ref in phase['captureFiles']}
  def read(name,maximum):
   check();assert name in refs and '/'not in name
   ref=refs[name];path=Path(ref['path']);assert path.parent==observer.capture_dir and ref['bytes']<=maximum
   with path.open('rb')as source:
    while True:
     check();block=source.read(65536)
     if not block:break
     yield block
  def raw(phase):
   for ref in phase['rawTraceShards']:
    with Path(ref['path']).open('rb')as source:
     for line in source:check();yield line
  limits=json.loads((ROOT/'scripts/lib/module-artifact-limits.json').read_text())
  record['report']=backend.bindings.observe([(name,raw(phase))for(name,_),phase in zip(commands,record['phases'])],read,{},check=check,limits=limits,compact_tool_coverage=True)
  assert record['report']['overallSdkSourceVerified']is False and record['report']['verifiedCoordinatedWaitIntervals']
  if observer.generated_vma.retained_metadata:
   record['generatedMetadata']=dict(producerPeakBytes=observer.generated_vma.metadata_high_water,reader=record['report']['observedGeneratedRetainedMetadata'])
   assert record['generatedMetadata']['producerPeakBytes']<=4*1024**2 and record['generatedMetadata']['reader']['peakBytes']<=4*1024**2
  assert (build/'diagnostic').is_file()
  executed=subprocess.run([str(build/'diagnostic')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5,check=False)
  assert executed.returncode==0 and not executed.stdout and not executed.stderr,'actual compiled diagnostic failed'
  record['actualCompiledProgramReturnCode']=executed.returncode
  selected={}
  for phase in record['phases']:
   for row in backend.probe.decoded_raw_records(raw(phase)):
    if row['kind']=='actual-rename-window'and 'generatedCheckpointSequence'in row:selected.setdefault('rename',row)
    if row['kind']=='generated-vma-consumer-binding'and row.get('metadataTransitions'):selected.setdefault('consumer',row)
  assert set(selected)=={'rename','consumer'},'actual generated checkpoint rename/consumer evidence missing'
  changes={
   'wrong-checkpoint':('rename',lambda row:row.update(generatedCheckpointSequence=1)),
   'ordinary-reference':('rename',lambda row:row.update(producerCaptureSequence=row.pop('generatedCheckpointSequence'))),
   'both-references':('rename',lambda row:row.update(producerCaptureSequence=row['generatedCheckpointSequence'])),
   'wrong-source-path':('rename',lambda row:row.update(fromPath='/opt/qlever-sdk/build/not-the-observed-path')),
   'missing-metadata-chain':('consumer',lambda row:row.update(metadataTransitions=[])),
   'wrong-metadata-reference':('consumer',lambda row:row.update(metadataTransitions=[1])),
  }
  def altered(phase,sequence,change):
   encoder=backend.probe.IndexedRawEncoder()
   for row in backend.probe.decoded_raw_records(raw(phase)):
    if row['sequence']==sequence:change(row)
    yield from encoder.encode(row)
  record['refusals']={}
  record['mutationSuite']='covered-by-normal-probe' if metadata_stress else 'six-actual-trace-mutations'
  for name,(target,change)in ([] if metadata_stress else changes.items()):
   sequence=selected[target]['sequence']
   try:backend.bindings.observe([(phase_name,altered(phase,sequence,change))for(phase_name,_),phase in zip(commands,record['phases'])],read,{},check=check,limits=limits,compact_tool_coverage=True)
   except(ValueError,KeyError,AssertionError,TypeError)as error:record['refusals'][name]=str(error)
   else:raise AssertionError('accepted altered actual Clang trace: '+name)
  record['completed']=True
 except Exception as error:
  failed=True;record.update(completed=False,errorType=type(error).__name__,error=str(error),traceback=traceback.format_exc()[-16000:])
 finally:
  record['cleanup']=shared.close_actual(observer,out/'cleanup.actual.jsonl');(out/'observation.json').write_text(json.dumps(record,indent=2)+'\n')
  print(json.dumps({k:v for k,v in record.items()if k not in ['phases','report','traceback']}),flush=True)
 if failed:raise RuntimeError('actual CMake/Clang diagnostic failed; see original observation')
if __name__=='__main__':
 assert len(sys.argv)in [2,3] and (len(sys.argv)==2 or sys.argv[2]=='--metadata-stress');run(sys.argv[1],metadata_stress=len(sys.argv)==3)
