import { afterAll, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Tiny, offline unit checks. These never invoke the public consumer or install.
const driver = path.resolve(import.meta.dir, '../../scripts/css-module-consumer.py');
const testRoot = path.resolve(import.meta.dir, '../../.test-data/css-module-consumer-tests');
afterAll(() => rmSync(testRoot, { recursive: true, force: true }));
function python(body: string) {
  const result = spawnSync('python3', ['-c', `
import importlib.util, pathlib, tempfile, json, hashlib, base64, os, types
from unittest.mock import patch
testbase=pathlib.Path(${JSON.stringify(testRoot)});testbase.mkdir(parents=True,exist_ok=True)
spec=importlib.util.spec_from_file_location('consumer', ${JSON.stringify(driver)})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
${body}
`], { encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
}

test('original SHA and SRI are both verified without changing bytes', () => {
  python(`
with tempfile.TemporaryDirectory(dir=testbase) as temp:
 p=pathlib.Path(temp)/'original.tgz';p.write_bytes(b'original')
 ref=dict(path=str(p),sha256=m.digest(p),integrity='sha512-'+m.digest(p,'sha512'))
 assert m.reference(ref,True)==p.resolve()
 try:m.reference(dict(ref,integrity='sha512-wrong'),True)
 except ValueError:pass
 else:raise AssertionError('bad SRI admitted')
 assert p.read_bytes()==b'original'
`);
});

test('failed fake subprocess preserves closed raw hashes and known wait status', () => {
  python(`
with tempfile.TemporaryDirectory(dir=testbase) as temp:
 root=pathlib.Path(temp)
 runner=m.Runner({'budget':{'estimatedPeakBytes':1,'remainingFloorBytes':m.GIB,'cushionBytes':128*m.MIB}}, {'output':root,'parent':root})
 runner.result={'status':'running','records':runner.records}
 class Fake:
  pid=424242;returncode=9
  def __init__(self,*args,**kwargs):kwargs['stderr'].write(b'failure evidence')
  def wait(self,**kwargs):return 9
  def poll(self):return 9
 def gone(*args):raise ProcessLookupError()
 with patch.object(m.subprocess,'Popen',Fake),patch.object(m.os,'killpg',gone),patch.object(runner,'gate',lambda:None),patch.object(runner,'observe_group',lambda process:{}):
  try:runner.command('fake',['not-a-real-command'],{},root)
  except ValueError:pass
  else:raise AssertionError('failure admitted')
 row=runner.records[0]
 assert row['status']=='failed' and row['waitStatus']=='known' and row['rawClosed']
 assert len(row['raw'])==2
 assert row['raw'][1]['sha256']==hashlib.sha256(b'failure evidence').hexdigest()
 assert json.loads((root/'result.json').read_text())['records'][0]['returncode']==9
`);
});

test('resource gate enforces peak plus floor plus cushion', () => {
  python(`
with tempfile.TemporaryDirectory(dir=testbase) as temp:
 root=pathlib.Path(temp)
 runner=m.Runner({'budget':{'estimatedPeakBytes':100,'remainingFloorBytes':m.GIB,'cushionBytes':128*m.MIB}}, {'output':root,'parent':root})
 threshold=100+m.GIB+128*m.MIB
 with patch.object(m.shutil,'disk_usage',lambda _:types.SimpleNamespace(free=threshold-1)):
  try:runner.gate(initial=True)
  except ValueError:pass
  else:raise AssertionError('floor ignored')
 with patch.object(m.shutil,'disk_usage',lambda _:types.SimpleNamespace(free=threshold)):runner.gate(initial=True)
`);
});

test('CLI defaults to validation and rejects malformed plan before creating output', () => {
  python(`
with tempfile.TemporaryDirectory(dir=testbase) as temp:
 root=pathlib.Path(temp);output=root/'must-not-exist'
 try:m.validate({'schemaVersion':1,'sourceSha':'bad','output':str(output)})
 except ValueError:pass
 else:raise AssertionError('bad plan admitted')
 assert not output.exists()
 assert "add_argument('--run', action='store_true'" in pathlib.Path(${JSON.stringify(driver)}).read_text()
`);
});

test('plan binds both producer projections to actual checkout and rejects source drift', () => {
  python(`
with tempfile.TemporaryDirectory(dir=testbase) as temp:
 root=pathlib.Path(temp).resolve();source=root/'source';source.mkdir();(source/'package.json').write_text('{}')
 private=root/'private';private.mkdir(mode=0o700)
 projected=root/'projected';projected.mkdir()
 def save(name,data):
  p=projected/name;p.write_text(json.dumps(data));return {'path':str(p),'sha256':m.digest(p)}
 archives={}
 for name in ['product','cli','client']:
  p=projected/(name+'.tgz');p.write_bytes(name.encode());archives[name]={'path':str(p),'sha256':m.digest(p),'integrity':'sha512-'+m.digest(p,'sha512'),'bytes':p.stat().st_size}
 sha='a'*40
 custody=save('custody.receipt.json',{})
 consumer=save('consumer-input.json',dict(schemaVersion=1,expectedSourceSha=sha,archive=dict(archives['product'],path='product.tgz'),package=dict(name='@undefineds.co/xpod-css-darwin-arm64',target='darwin-arm64',version='1.2.3')))
 producer=save('producer.receipt.json',dict(context=dict(actualCheckoutSha=sha,workflowPath='.github/workflows/css-module-product.yml',runHeadSha=sha,runId=123,runAttempt=1,target='darwin-arm64',version='1.2.3'),archive=dict(archives['product'],path='product.tgz'),schemaVersion=1,kind='css-module-product-production',status='controlled-preview-materials',sourceBefore=dict(sha='a'*40,status=''),sourceAfter=dict(sha='a'*40,status=''),materials={name:dict(archiveMember='package/provenance/'+name+'.json') for name in ['compiler','css-scoped-components','css-resource-plan','identity-dedup','publication','css-native-runtime']},**{key:False for key in ['published','releaseQualified','consumerValidated','legalClearance','nativeAdmission']}))
 publication=save('publication-input.json',dict(schemaVersion=1,cli=archives['cli'],client=archives['client']))
 def relative(ref):return dict(ref,path=pathlib.Path(ref['path']).name)
 css=save('projection.receipt.json',dict(schemaVersion=1,kind='css-product-input-projection',status='projected-blocked',runHeadSha=sha,runId=123,runAttempt=1,sourceSha=sha,custodyReceipt=custody,published=False,releaseQualified=False,actualCheckoutVerified=False,exactAttemptAdmitted=False,registryConsumerValidated=False,phaseClosureAdmitted=False,consumerValidated=False,legalClearance=False,nativeAdmission=False,producerReceipt=relative(producer),consumerInput=relative(consumer),archive=relative(archives['product']),package=dict(name='@undefineds.co/xpod-css-darwin-arm64',target='darwin-arm64',version='1.2.3')))
 cli=save('cli.receipt.json',dict(schemaVersion=1,kind='cli-publication-input-projection',status='projected-blocked',sourceSha=sha,custodyReceipt=custody,published=False,releaseQualified=False,actualCheckoutVerified=False,exactAttemptAdmitted=False,registryConsumerValidated=False,publicationInput=relative(publication),products={key:dict(package='@undefineds.co/xpod-'+key,version='1.2.3',archive=relative(archives[key])) for key in ['cli','client']}))
 plan=dict(schemaVersion=1,sourceSha=sha,checkout=str(source),sourceRoots=[str(source)],cssReceipt=css,cliReceipt=cli,cssArchive=archives['product'],cliArchive=archives['cli'],clientArchive=archives['client'],node=m.sys.executable,bun=m.sys.executable,output=str(private/'evidence'),temporaryParent=str(private),budget=dict(estimatedPeakBytes=1,remainingFloorBytes=m.GIB,cushionBytes=128*m.MIB))
 with patch.object(m.subprocess,'check_output',lambda *args,**kwargs:sha+'\\n'):
  checked=m.validate(plan);assert checked['css']['sourceSha']==sha
  assert not pathlib.Path(plan['output']).exists()
  try:m.validate(dict(plan,sourceSha='b'*40))
  except ValueError:pass
  else:raise AssertionError('different actual checkout admitted')
  try:m.validate(dict(plan,output=str(source/'bad-evidence')))
  except ValueError:pass
  else:raise AssertionError('source write admitted')
`);
});

test('selected runtime wrapper invokes a shell public launcher without parsing it as JS', () => {
  python(`
with tempfile.TemporaryDirectory(prefix='consumer quote ',dir=testbase) as temp:
 root=pathlib.Path(temp)
 preload=root/'transport.mjs';preload.write_text('// fixture')
 for runtime,flag in [('node','--import'),('bun','--preload')]:
  binary=root/(runtime+'-fake');binary.write_text('#!/bin/sh\\nprintf "%s\\\\n" "$@"\\n');binary.chmod(0o700)
  directory=root/(runtime+'-bin');m.runtime_wrapper(directory,runtime,str(binary),preload)
  launcher=root/(runtime+'-public');launcher.write_text('#!/bin/sh\\nexec '+runtime+' fixture-payload --help\\n');launcher.chmod(0o700)
  result=m.subprocess.run([str(launcher)],env={'PATH':str(directory)},capture_output=True,text=True)
  assert result.returncode==0 and result.stdout.splitlines()==[flag,str(preload),'fixture-payload','--help']
  assert not (directory/('bun' if runtime=='node' else 'node')).exists()
`);
});

test('retains data by rename and refuses overwrite before install cleanup', () => {
  python(`
with tempfile.TemporaryDirectory(dir=testbase) as temp:
 root=pathlib.Path(temp);cycle=root/'cycle';cycle.mkdir();output=root/'output';output.mkdir()
 data=cycle/'data';data.mkdir();(data/'pod.sqlite').write_bytes(b'user pod evidence')
 inode=data.stat().st_ino
 retained=m.retain_data(cycle,output,'node')
 assert retained.stat().st_ino==inode and (retained/'pod.sqlite').read_bytes()==b'user pod evidence'
 m.shutil.rmtree(cycle)
 assert (retained/'pod.sqlite').exists()
 cycle.mkdir();(cycle/'data').mkdir()
 try:m.retain_data(cycle,output,'node')
 except ValueError:pass
 else:raise AssertionError('retained data overwritten')
`);
});

test('cleanup uncertainty retains failed phase raw evidence and cannot pass', () => {
  python(`
with tempfile.TemporaryDirectory(dir=testbase) as temp:
 root=pathlib.Path(temp)
 runner=m.Runner({'budget':{}},{'output':root,'parent':root});runner.result={'records':runner.records}
 class Fake:
  pid=424242;returncode=7
  def __init__(self,*args,**kwargs):kwargs['stderr'].write(b'primary failure')
  def poll(self):return 7
  def wait(self,**kwargs):return 7
 def uncertain(*args,**kwargs):raise RuntimeError('group ownership unknown')
 with patch.object(m.subprocess,'Popen',Fake),patch.object(runner,'gate',lambda:None),patch.object(runner,'observe_group',lambda process:{}),patch.object(runner,'stop',uncertain):
  try:runner.command('failed-cleanup',['fake'],{},root)
  except ValueError as error:assert 'command failed' in str(error)
  else:raise AssertionError('primary failure lost')
 row=runner.records[0]
 assert runner.groups_unknown and row['status']=='failed' and not row['rawClosed']
 assert row['rawHandlesClosed'] and not row['rawClosedBeforeHash'] and not row['rawEligible']
 assert all(raw['sha256'] is None and not raw['sizeIsFinal'] for raw in row['raw'])
 assert row['cleanupError']=='group ownership unknown' and row['raw'][1]['bytes']==15
`);
});

test('observed owned descendant receives TERM after its leader exits', () => {
  python(`
with tempfile.TemporaryDirectory(dir=testbase) as temp:
 root=pathlib.Path(temp);runner=m.Runner({}, {'output':root,'parent':root})
 marker=root/'term-delivered';ready=root/'child-ready'
 child="import signal,pathlib,time,sys;signal.signal(signal.SIGTERM,lambda *_:(pathlib.Path(sys.argv[1]).write_text('TERM'),sys.exit(0)));signal.alarm(10);pathlib.Path(sys.argv[2]).write_text('ready');time.sleep(10)"
 code="import subprocess,time,sys,pathlib;subprocess.Popen([sys.executable,'-c',sys.argv[1],sys.argv[2],sys.argv[3]]);time.sleep(.5)"
 process=m.subprocess.Popen([m.sys.executable,'-c',code,child,str(marker),str(ready)],start_new_session=True,stdout=m.subprocess.DEVNULL,stderr=m.subprocess.DEVNULL)
 witnesses={}
 try:
  deadline=m.time.monotonic()+3
  while True:
   witnesses=runner.observe_group(process)
   if len(witnesses)>=2 and ready.exists():break
   assert m.time.monotonic()<deadline
   m.time.sleep(.02)
  process.wait(timeout=2)
  try:runner.stop(process,timeout=3)
  except PermissionError:assert runner.groups_unknown
  else:
   assert not runner.groups_unknown and not runner.forced
   try:m.os.killpg(process.pid,0)
   except ProcessLookupError:pass
   except PermissionError:runner.groups_unknown=True
   else:raise AssertionError('descendant survived')
  deadline=m.time.monotonic()+3
  while not marker.exists():
   assert m.time.monotonic()<deadline
   m.time.sleep(.02)
  assert marker.read_text()=='TERM'
  # A denied group probe never proves absence; independently check the
  # recorded child's PID/start identity has disappeared after TERM delivery.
  while True:
   current=m.subprocess.check_output(['/bin/ps','-axo','pid=,pgid=,lstart='],text=True)
   remaining={int(p[0]):p[2] for line in current.splitlines() if len(p:=line.split(None,2))==3}
   if all(pid==process.pid or remaining.get(pid)!=start for pid,start in witnesses.items()):break
   assert m.time.monotonic()<deadline
   m.time.sleep(.02)
 finally:
  # Never blindly kill a PGID after an unknown/EPERM observation.
  if not runner.groups_unknown:
   try:
    members=runner.observe_group(process)
    if members and any(witnesses.get(pid)==start for pid,start in members.items()):m.os.killpg(process.pid,m.signal.SIGKILL)
   except (PermissionError,ProcessLookupError):runner.groups_unknown=True
  process.wait()
`);
});

test('independent installed inventory rejects changed bytes, extra files, links and special files', () => {
  python(`
with tempfile.TemporaryDirectory(dir=testbase) as temp:
 root=pathlib.Path(temp);file=root/'entry.mjs';file.write_bytes(b'original');file.chmod(0o644)
 package={'name':'fixture-css','version':'1.2.3','xpodModule':{'files':[{'path':'entry.mjs','sha256':m.digest(file),'size':8,'mode':0o644}]}}
 manifest=root/'package.json';manifest.write_text(json.dumps(package))
 installed={'package':'fixture-css','version':'1.2.3','manifestSha256':m.digest(manifest)}
 assert m.inventory(root,installed)==package
 def rejected():
  try:m.inventory(root,installed)
  except ValueError:pass
  else:raise AssertionError('inventory drift admitted')
 file.write_bytes(b'mutation');rejected();file.write_bytes(b'original')
 extra=root/'extra';extra.write_bytes(b'extra');rejected();extra.unlink()
 extra.symlink_to(file);rejected();extra.unlink()
 m.os.mkfifo(extra);rejected();extra.unlink()
 assert m.inventory(root,installed)==package
`);
});

test('EPERM group probe marks unknown and never treats it as absence', () => {
  python(`
with tempfile.TemporaryDirectory(dir=testbase) as temp:
 root=pathlib.Path(temp);runner=m.Runner({}, {'output':root,'parent':root})
 process=types.SimpleNamespace(pid=424242,poll=lambda:0,wait=lambda **kwargs:0)
 runner.group_members[process.pid]={424243:'recorded start'}
 def denied(pid,number):
  if number==0:raise PermissionError('EPERM group observation')
 with patch.object(runner,'observe_group',lambda _:{424243:'recorded start'}),patch.object(m.os,'killpg',denied):
  try:runner.stop(process,timeout=1)
  except PermissionError:pass
  else:raise AssertionError('EPERM admitted as absent')
 assert runner.groups_unknown and not runner.forced
`);
});

test('late EPERM preserves command raw files without final hashes', () => {
  python(`
with tempfile.TemporaryDirectory(dir=testbase) as temp:
 root=pathlib.Path(temp);runner=m.Runner({'budget':{}},{'output':root,'parent':root});runner.result={'records':runner.records}
 class Fake:
  pid=424242;returncode=0
  def __init__(self,*args,**kwargs):kwargs['stdout'].write(b'raw evidence')
  def poll(self):return 0
  def wait(self,**kwargs):return 0
 calls=[]
 def probe(*args):
  calls.append(args)
  if len(calls)==1:raise ProcessLookupError()
  raise PermissionError('late EPERM')
 with patch.object(m.subprocess,'Popen',Fake),patch.object(runner,'gate',lambda:None),patch.object(runner,'observe_group',lambda _:{}),patch.object(m.os,'killpg',probe):
  try:runner.command('late-eperm',['fake'],{},root)
  except ValueError as error:assert 'closure unknown' in str(error)
  else:raise AssertionError('late EPERM passed')
 row=runner.records[0]
 assert runner.groups_unknown and row['status']=='failed' and row['rawHandlesClosed']
 assert not row['rawEligible'] and all(raw['sha256'] is None for raw in row['raw'])
`);
});


test('installer rename and unlink produce partial samples without changing complete peaks or cap claims', () => {
  python(`
with tempfile.TemporaryDirectory(dir=testbase) as temp:
 root=pathlib.Path(temp);owned=root/'owned';owned.mkdir();output=root/'output';output.mkdir()
 retained=owned/'retained';retained.write_bytes(b'original')
 for operation in ['rename','unlink']:
  transient=owned/'transient';transient.write_bytes(b'temporary')
  if operation=='rename':transient.rename(owned/'renamed')
  else:transient.unlink()
  with patch.object(m.os,'walk',lambda *args,**kwargs:iter([(str(owned),[],['retained','transient'])])):
   sample=m.allocated_bytes(owned)
  assert sample['complete'] is False and sample['disappearedEntries']==1
  assert sample['observedBytes']==retained.stat().st_blocks*512
  if (owned/'renamed').exists():(owned/'renamed').unlink()
 runner=m.Runner({'budget':dict(estimatedPeakBytes=100000,remainingFloorBytes=m.GIB,cushionBytes=128*m.MIB)}, {'output':output,'parent':root});runner.owned=owned
 runner.disk_coverage.update(peakCompleteBytes=123,lastCompleteBytes=123,completeSamples=1)
 with patch.object(m,'allocated_bytes',lambda _:dict(observedBytes=999999,complete=False,disappearedEntries=1)),patch.object(m.shutil,'disk_usage',lambda _:types.SimpleNamespace(free=2*m.GIB)):
  runner.gate()
 assert runner.disk_coverage['peakCompleteBytes']==123 and runner.disk_coverage['lastCompleteBytes']==123
 assert runner.disk_coverage['partialSamples']==1 and runner.disk_coverage['capCheckedOnLastSample'] is False
 # Partial allocation sampling never bypasses the independent free-space floor.
 with patch.object(m,'allocated_bytes',lambda _:dict(observedBytes=0,complete=False,disappearedEntries=1)),patch.object(m.shutil,'disk_usage',lambda _:types.SimpleNamespace(free=m.GIB-1)):
  try:runner.gate()
  except ValueError:pass
  else:raise AssertionError('partial sample bypassed floor')
`);
});

test('permission and unexpected allocation errors remain blocking', () => {
  python(`
with tempfile.TemporaryDirectory(dir=testbase) as temp:
 root=pathlib.Path(temp);(root/'file').write_bytes(b'original')
 for error in [PermissionError('unknown allocation'),OSError('unexpected I/O')]:
  with patch.object(m.os,'lstat',side_effect=error):
   try:m.allocated_bytes(root)
   except type(error):pass
   else:raise AssertionError('allocation error ignored')
`);
});

test('normal service TERM reaches parent first and parent closes its child', () => {
  python(`
with tempfile.TemporaryDirectory(dir=testbase) as temp:
 root=pathlib.Path(temp);runner=m.Runner({}, {'output':root,'parent':root})
 events=root/'events';ready=root/'ready'
 child="import signal,time,sys,pathlib;signal.signal(signal.SIGTERM,lambda *_:(open(sys.argv[2],'a').write('child TERM|'),sys.exit(0)));pathlib.Path(sys.argv[1]).write_text('ready');time.sleep(10)"
 parent="""import signal,subprocess,time,sys,pathlib
p=subprocess.Popen([sys.executable,'-c',sys.argv[1],sys.argv[2],sys.argv[3]])
def close(*_):
 pathlib.Path(sys.argv[3]).write_text('parent TERM|')
 p.terminate();assert p.wait(timeout=2)==0
 with open(sys.argv[3],'a') as f:f.write('child waited|')
 sys.exit(0)
signal.signal(signal.SIGTERM,close)
while not pathlib.Path(sys.argv[2]).exists():time.sleep(.01)
time.sleep(10)
"""
 process=m.subprocess.Popen([m.sys.executable,'-c',parent,child,str(ready),str(events)],start_new_session=True)
 try:
  deadline=m.time.monotonic()+3
  while not ready.exists():
   assert m.time.monotonic()<deadline;m.time.sleep(.01)
  signals=[];original=m.os.killpg
  def observe(pid,sig):
   signals.append(sig);return original(pid,sig)
  with patch.object(m.os,'killpg',observe),patch.object(runner,'gate',lambda:None):runner.close_service(process)
  assert process.returncode==0 and not runner.forced and not runner.groups_unknown
  assert events.read_text()=='parent TERM|child TERM|child waited|'
  assert signals and all(sig==0 for sig in signals)
 finally:
  if process.poll() is None:runner.stop(process,timeout=2)
`);
});

test('service graceful timeout fails before group cleanup broadcasts TERM', () => {
  python(`
with tempfile.TemporaryDirectory(dir=testbase) as temp:
 root=pathlib.Path(temp);runner=m.Runner({}, {'output':root,'parent':root});runner.result={'records':runner.records}
 ready=root/'ready';events=root/'events'
 code="""import signal,time,sys,pathlib
count=0
def close(*_):
 global count
 count+=1
 with open(sys.argv[2],'a') as f:f.write('TERM|')
 if count==2:sys.exit(0)
signal.signal(signal.SIGTERM,close)
pathlib.Path(sys.argv[1]).write_text('ready')
time.sleep(10)
"""
 def healthy(process):
  deadline=m.time.monotonic()+3
  while not ready.exists():
   assert m.time.monotonic()<deadline;m.time.sleep(.01)
 close=runner.close_service;signals=[];original=m.os.killpg
 def broadcast(pid,sig):
  if sig:signals.append(sig)
  return original(pid,sig)
 with patch.object(runner,'gate',lambda:None),patch.object(runner,'close_service',lambda p:close(p,timeout=.15)),patch.object(m.os,'killpg',broadcast):
  try:runner.command('timeout',[m.sys.executable,'-c',code,str(ready),str(events)],os.environ.copy(),root,healthy)
  except m.subprocess.TimeoutExpired:pass
  else:raise AssertionError('graceful timeout passed')
 row=runner.records[0]
 assert row['status']=='failed' and row['returncode']==0 and row['ownedGroupAbsent'] and row['rawClosed']
 assert signals==[m.signal.SIGTERM] and events.read_text()=='TERM|TERM|'
`);
});

test('stale leader snapshot requires an ESRCH recheck after fast exit', () => {
  python(`
with tempfile.TemporaryDirectory(dir=testbase) as temp:
 root=pathlib.Path(temp);runner=m.Runner({}, {'output':root,'parent':root})
 polls=iter([None,0]);process=types.SimpleNamespace(pid=424242,poll=lambda:next(polls))
 probes=[]
 def gone(pid,sig):
  probes.append((pid,sig));raise ProcessLookupError()
 with patch.object(m.subprocess,'check_output',lambda *a,**k:'424242 424242 original start'),patch.object(m.os,'killpg',gone):
  assert runner.observe_group(process)=={}
 assert probes==[(424242,0)] and not runner.groups_unknown
 assert runner.last_group_observation['members']=={424242:'original start'}
 assert runner.last_group_observation['pollBefore'] is None and runner.last_group_observation['pollAfter']==0
 assert runner.last_group_observation['absenceProbe']=='ESRCH'
`);
});

test('fast exit rejects EPERM, unknown descendants and reused identities', () => {
  python(`
with tempfile.TemporaryDirectory(dir=testbase) as temp:
 root=pathlib.Path(temp)
 for mode,snapshot in [('EPERM','424242 424242 original start'),('unknown','424243 424242 stranger'),('reused','424243 424242 new start'),('empty','')]:
  runner=m.Runner({}, {'output':root,'parent':root});runner.records.append({})
  runner.group_members[424242]={424243:'old start'}
  polls=iter([None,0]);process=types.SimpleNamespace(pid=424242,poll=lambda:next(polls))
  def probe(pid,sig):
   assert (pid,sig)==(424242,0)
   if mode=='EPERM':raise PermissionError('denied')
  with patch.object(m.subprocess,'check_output',lambda *a,**k:snapshot),patch.object(m.os,'killpg',probe):
   try:runner.observe_group(process)
   except PermissionError:assert mode=='EPERM'
   except ValueError:assert mode!='EPERM'
   else:raise AssertionError('unknown group admitted: '+mode)
  assert runner.groups_unknown
  diagnostic=runner.records[-1]['groupObservationFailure']
  assert diagnostic['absenceProbe']==('PermissionError' if mode=='EPERM' else 'present')
  assert diagnostic['previous']=={424243:'old start'}
`);
});

test('initial observation failure retains the spawned PID and bounded diagnostics', () => {
  python(`
with tempfile.TemporaryDirectory(dir=testbase) as temp:
 root=pathlib.Path(temp);runner=m.Runner({}, {'output':root,'parent':root});runner.result={'records':runner.records}
 class Fake:
  pid=424242;returncode=0
  def __init__(self,*a,**k):pass
  def poll(self):return 0
  def wait(self,**k):return 0
 def denied(*a):raise PermissionError('group probe denied')
 with patch.object(m.subprocess,'Popen',Fake),patch.object(runner,'gate',lambda:None),patch.object(m.subprocess,'check_output',lambda *a,**k:'424243 424242 stranger'),patch.object(m.os,'killpg',denied):
  try:runner.command('fast',['fake'],{},root)
  except PermissionError:pass
  else:raise AssertionError('initial group denial passed')
 row=runner.records[0]
 assert row['pid']==424242 and row['status']=='failed' and not row['rawEligible']
 assert row['groupObservationFailure']['absenceProbe']=='PermissionError'
 assert json.loads((root/'result.json').read_text())['records'][0]['pid']==424242
`);
});

test('poll failure preserves the original exception and initialized diagnostics', () => {
  python(`
with tempfile.TemporaryDirectory(dir=testbase) as temp:
 root=pathlib.Path(temp);runner=m.Runner({}, {'output':root,'parent':root});runner.records.append({})
 failure=RuntimeError('poll failed')
 def broken():raise failure
 process=types.SimpleNamespace(pid=424242,poll=broken)
 try:runner.observe_group(process)
 except RuntimeError as error:assert error is failure
 else:raise AssertionError('poll error lost')
 assert runner.groups_unknown and runner.records[-1]['groupObservationFailure']['pollBefore'] is None
`);
});
