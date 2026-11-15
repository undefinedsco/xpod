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

def run(destination,parked_parents=0,classic_wait=False):
 assert type(parked_parents)is int and 0<=parked_parents<=2
 out=Path(destination);out.mkdir(parents=True,exist_ok=False)
 build=Path('/opt/qlever-sdk/build');assert build.is_dir() and not any(build.iterdir()),'isolated empty canonical build root required'
 source=ROOT/'qlever/tests/fixtures/coordinated-wait.c';binary=out/'actual-coordinated-probe'
 command=['/usr/bin/cc','-std=c11','-O2','-pthread','-Wall','-Wextra','-Werror',str(source),'-o',str(binary)]
 if classic_wait:command.insert(1,'-DOWNER_WAIT_CLASSIC')
 compiled=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30,check=False)
 (out/'compile.stdout.raw').write_bytes(compiled.stdout);(out/'compile.stderr.raw').write_bytes(compiled.stderr)
 assert compiled.returncode==0,'actual native fixture compilation failed'
 originals=out/'originals';originals.mkdir()
 observer=backend.SdkExecutionObserver(originals,'/opt/qlever-sdk/source',build,deadline_monotonic=time.monotonic()+30,check_budget=lambda:None,maximum_bytes=512*1024**2,maximum_stdio_bytes=1024**2)
 result=dict(qualification=False,scope='native coordinated wait mechanics, not the fixed SDK configure/build command',compileCommand=command,sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest(),binarySha256=hashlib.sha256(binary.read_bytes()).hexdigest())
 try:
  command=[str(binary)]
  for _ in range(parked_parents):command=['/usr/bin/bash','-c','"$@"; fixture_status=$?; exit "$fixture_status"','fixture-parent',*command]
  phase=backend.Observer.phase(observer,'configure',command,cwd='/opt/qlever-sdk/source',env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'})
  assert phase['trackingReceipt']['actualRootReturnCode']==0 and phase['trackingReceipt']['trackedProcessesClosed']
  stdout=json.loads((originals/'configure.stdout.raw').read_text());assert stdout['waited']==0 and stdout['woken']==1 and stdout['value']==66 and stdout['ioUringErrno']==38 and stdout['sideWaited']==-1 and stdout['sideErrno']==11
  raw=b''.join(Path(ref['path']).read_bytes() for ref in phase['rawTraceShards']);rows=list(backend.probe.decoded_raw_records(raw.splitlines(keepends=True)))
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
  def replay(values):
   encoder=backend.probe.IndexedRawEncoder()
   return backend.bindings.observe([('configure',[line for row in values for line in encoder.encode(row)])],read_original,{},limits=limits)
  report=replay(rows);assert report['overallSdkSourceVerified']is False and len(report['verifiedCoordinatedWaitIntervals'])==1 and not report['verifiedPrivateWaitMismatchEntrySequences']
  assert any(row['kind']=='generated-vma-write-origin-transition' for row in rows),'actual post-unmap write bridge missing'
  assert any(row['kind']=='generated-kernel-wait-side-wait-deferred'for row in rows),'actual equal peer entry not deferred'
  assert report['verifiedCoordinatedWaitIntervals'][0]['sideWaitMismatches'],'actual peer mismatch interval missing'
  window=next(i for i,row in enumerate(rows)if row['kind']=='generated-kernel-wait-window');closed=next(i for i,row in enumerate(rows)if row['kind']=='generated-kernel-wait-closed');resume=next(i for i,row in enumerate(rows)if row['kind']=='generated-kernel-wait-peer-resume');stop=next(i for i,row in enumerate(rows)if row['kind']=='generated-kernel-wait-peer-stopped')
  initial=rows[window];universe=initial['stoppedUniverse'];members=initial['members'];parked=[pid for pid in universe if pid not in members]
  root_at=next(i for i,row in enumerate(rows)if row['kind']=='owned-root-binding')
  assert report['verifiedCoordinatedWaitIntervals'][0]['sideWakeEntries'],'actual side wake interval missing'
  side_wake=next(i for i,row in enumerate(rows)if row['kind']=='generated-kernel-wait-side-wait-window'and row['operation']=='private-side-wake')
  deferred=next(i for i,row in enumerate(rows)if row['kind']=='generated-kernel-wait-side-wait-deferred')
  side=next(i for i,row in enumerate(rows)if row['kind']=='generated-kernel-wait-side-wait-window')
  side_closed=next(i for i,row in enumerate(rows)if row['kind']=='generated-kernel-wait-side-wait-closed')
  assert len(parked)==parked_parents and rows[root_at]['generatedVmaModel']==backend.generated_vma_module.PARKED_WAIT_MODEL
  assert rows[root_at]['optionalIoUringModel']=='explicit-kernel-enosys-denial-v2'
  assert rows[root_at]['mapsOriginalEntityModel']=='same-phase-maps-content-entity-v1'
  maps_alias=next(i for i,row in enumerate(rows)if row['kind']=='toolchain-original'and row['captureKind']=='maps'and 'originalReuse'in row)
  maps_rows=[row for row in rows if row['kind']=='toolchain-original'and row['captureKind']=='maps'];physical_maps={row['original']['path']:row['original']['bytes']for row in maps_rows}
  assert all(row['original']['observationSequence']==row['sequence']for row in maps_rows)
  result['mapsStorage']=dict(samples=len(maps_rows),physicalBodies=len(physical_maps),referencedBytes=sum(row['original']['bytes']for row in maps_rows),physicalBytes=sum(physical_maps.values()))
  assert any(row['kind']=='explicit-io-uring-setup-denied-exit'and row['result']==-38 and row['isError']is True for row in rows)
  mutations={
   'maps-relabelled-legacy':lambda values:values[root_at].pop('mapsOriginalEntityModel'),
   'maps-unmarked-alias':lambda values:values[maps_alias].pop('originalReuse'),
   'maps-wrong-observation':lambda values:values[maps_alias]['original'].update(observationSequence=1),
   'maps-wrong-observed-pid':lambda values:values[maps_alias].update(observedPid=9999),
   'maps-missing-fresh-window':lambda values:values[maps_alias].pop('mapsNamedWindowAfterIdentity'),
   'maps-changed-entity':lambda values:values[maps_alias]['originalEntityIdentity'].__setitem__(1,9999),
   'foreign-peer':lambda values:values[resume].update(pid=9999),
   'injected-signal':lambda values:values[resume].update(signal=18),
   'wrong-epoch':lambda values:values[window].update(epochSequence=1),
   'forged-interrupt':lambda values:values[stop].update(waitStatus=34175),
   'wrong-closure':lambda values:values[closed].update(wakeEntrySequence=1),
   'missing-universe-member':lambda values:values[window]['stoppedUniverse'].pop(),
   'missing-stopped-state':lambda values:values[window]['stoppedTaskStates'].pop(),
   'running-stopped-task':lambda values:values[window]['stoppedTaskStates'][0].update(state='S'),
   'wrong-closed-universe':lambda values:values[closed].update(stoppedUniverse=[]),
   'relabelled-v7':lambda values:values[root_at].update(generatedVmaModel=backend.generated_vma_module.COORDINATED_WAIT_MODEL),
   'deferred-forged-word':lambda values:values[deferred].update(wordOriginal=backend.generated_vma_module.raw_record(b'\x01\0\0\0')),
   'deferred-injected-resume':lambda values:values[deferred].update(request='PTRACE_SYSCALL'),
   'deferred-wrong-entry':lambda values:values[deferred].update(entrySequence=1),
   'deferred-missing-stopped-peer':lambda values:values[deferred]['stoppedTaskStates'].pop(),
   'deferred-lost-prior-queue':lambda values:values[window].update(deferredPeerEntries=[dict(pid=9999,entrySequence=1)]),
   'side-wake-false-count':lambda values:values[side_wake+2].update(result=1),
   'side-wake-forged-error':lambda values:values[side_wake+2].update(isError=True),
   'side-wake-relabelled':lambda values:values[side_wake].update(operation='private-wait-mismatch'),
   'side-wake-injected-signal':lambda values:values[side_wake+1].update(signal=17),
   'side-wake-primary-word':lambda values:values[side_wake-1]['args'].__setitem__(0,next(row['args'][0]for row in rows if row['sequence']==initial['entrySequence'])),
   'peer-false-success':lambda values:values[side+2].update(result=0,isError=False),
   'peer-injected-signal':lambda values:values[side+1].update(signal=17),
   'peer-changed-word':lambda values:values[side_closed].update(wordOriginal=backend.generated_vma_module.raw_record(b'\x01\0\0\0')),
   'peer-forged-waiter':lambda values:values[side_closed]['observation'].update(pid=9999),
   'peer-wrong-exit':lambda values:values[side_closed].update(exitSequence=1),
   'peer-equal-word':lambda values:(values[side].update(wordOriginal=backend.generated_vma_module.raw_record((25).to_bytes(4,'little'))),values[side_closed].update(wordOriginal=backend.generated_vma_module.raw_record((25).to_bytes(4,'little')))),
  }
  if parked:
   mutations['omitted-parked-ancestor']=lambda values:values[window]['stoppedUniverse'].remove(parked[0])
   mutations['parked-ancestor-as-peer']=lambda values:values[resume].update(pid=parked[0])
  refused={}
  for name,mutate in mutations.items():
   changed=copy.deepcopy(rows);mutate(changed)
   try:replay(changed)
   except (ValueError,KeyError,AssertionError,TypeError,StopIteration) as error:refused[name]=str(error)
   else:raise AssertionError('accepted altered native trace: '+name)
  result.update(actualPhase=phase,nativeStdout=stdout,report=report,refusals=refused,parkedAncestors=parked)
 finally:
  result['cleanup']=shared.close_actual(observer,out/'cleanup.actual.jsonl')
  (out/'observation.json').write_text(json.dumps(result,indent=2)+'\n')
 output=build/'finite-output';assert sorted(build.iterdir())==[output] and output.read_bytes()==b'z','unexpected fixture build contents';output.unlink()
if __name__=='__main__':
 root=Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=False)
 for name,count in [('cohort-only',0),('parked-parent',1),('parked-ancestors',2)]:
  for classic in [False,True]:run(root/(name+('-classic'if classic else '')),count,classic)
