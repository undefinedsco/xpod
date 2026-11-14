/** Bounded pure-mechanics checks for the native-runtime producer adapter. */
import{test,expect}from'bun:test';
import{execFileSync}from'node:child_process';
const producer='qlever/scripts/sdk-service-native-runtime-originals.py';
const worker=String.raw`
import hashlib,importlib.util,json,os,sys,tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('producer',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(os.path.realpath(tempfile.mkdtemp()))
m.ROOTS=(str(root),)
m.ROOT_TOKENS={'out':str(root/'out')}
m.OUTPUT_ROOT=str(root/'out')
sha=lambda b:hashlib.sha256(b).hexdigest()
# 1. Real profile schema accepted with NO invented identity fields.
profile=root/'inputs.json'
payload={'schemaVersion':1,'profile':'service-trixie','baseImage':'debian@sha256:'+'a'*64,
 'machine':'x86_64','glibc':'glibc 2.41','compilerVersions':{'c':'gcc 12','cxx':'g++ 12','linker':'ld 2.44'},
 'compilerFiles':{role:{'path':'/usr/bin/'+role,'bytes':10,'sha256':'b'*64} for role in ('c','cxx','linker')},
 'packageLedgerSha256':'c'*64,'keyringSha256':'d'*64,'keyringOriginals':[],'signedReleaseOriginals':[],
 'packageIndexHashes':{},'stages':[],'dockerfileSha256':'e'*64,'runtimeDockerfileSha256':'f'*64,
 'lockSha256':'1'*64,'scope':'fixture schema only'}
profile.write_text(json.dumps(payload))
p=m.check_profile(str(profile),expected_source_sha='2'*40,expected_sdk_image='ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:'+'3'*64)
assert p['target']=='linux-x64' and p['machine']=='x86_64'
assert 'sourceSha' not in payload and 'sdkImage' not in payload and 'workspaceRoot' not in payload
# Supplied identities are separate asserted inputs: profile has no source/SDK
# field, so check_profile must not claim a match it cannot observe.
other=m.check_profile(str(profile),expected_source_sha='4'*40,expected_sdk_image='ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:'+'5'*64)
assert other['profile']=='service-trixie'
try:
    m.check_profile(str(profile),expected_source_sha='not-a-sha',expected_sdk_image='ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:'+'3'*64)
    raise SystemExit('bad supplied SHA accepted')
except ValueError: pass
badbase=root/'badbase.json';badbase.write_text(json.dumps({**payload,'baseImage':'debian:latest'}))
try:
    m.check_profile(str(badbase),expected_source_sha='2'*40,expected_sdk_image='ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:'+'3'*64)
    raise SystemExit('mutable base accepted')
except ValueError as e: assert 'base image' in str(e)
bad=root/'bad.json';bad.write_text(json.dumps({**payload,'machine':'mips64'}))
try: m.check_profile(str(bad),expected_source_sha='2'*40,expected_sdk_image='ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:'+'3'*64);raise SystemExit('unknown machine accepted')
except ValueError as e: assert 'machine' in str(e)
# 2. Held source inventory mechanics, explicitly not .git custody.
workspace=root/'workspace';(workspace/'qlever/scripts').mkdir(parents=True)
(workspace/'qlever/scripts/run-focused-native-build.sh').write_text('#!/bin/bash\n')
inventory=[{'path':'./qlever/scripts/run-focused-native-build.sh','bytes':14,'sha256':sha(b'#!/bin/bash\n')}]
w=m.check_workspace(str(workspace),inventory)
assert w['root']==workspace and w['inventory'][0]['path']=='qlever/scripts/run-focused-native-build.sh'
try:
    m.check_workspace(str(workspace),[{'path':'.git/HEAD','bytes':1,'sha256':'a'*64},
                                     {'path':'./qlever/scripts/run-focused-native-build.sh','bytes':14,'sha256':sha(b'#!/bin/bash\n')}])
    raise SystemExit('.git custody accepted')
except ValueError as e: assert 'explicit' in str(e) or 'tracked source path' in str(e)
# 3. Real upstream receipt shape, direct capture refs, tracking has no stdio.
receipt={'commandReceipt':{'schemaVersion':1,'command':['bash','x'],'actualExecutable':'/usr/bin/bash','pid':1,'pgid':1,
 'actualWait':True,'exit':0,'signal':None,'startedUnixNs':'1','completedUnixNs':'2','rawClosedBeforeHash':True,
 'stdout':{'path':'/tmp/o','bytes':1,'sha256':'a'*64},'stderr':{'path':'/tmp/e','bytes':0,'sha256':'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'}},
 'trackingReceipt':{'schemaVersion':1,'kind':'sdk-observer-tracked-phase-original','phase':'x','observerPid':2,
 'command':['bash','x'],'actualRootPid':1,'actualRootReturnCode':0,'actualTrackedWait':True,'trackedProcessesClosed':True,
 'deadlineMonotonic':1.0,'startedUnixNs':'1','completedUnixNs':'2','waitReferences':[]},
 'rawTraceShards':[{'path':'/tmp/t','bytes':1,'sha256':'b'*64,'wire':{'recordModel':'x'}}],
 'captureFiles':[{'path':'/tmp/c','bytes':1,'sha256':'c'*64}]}
assert m.validate_receipts(receipt) is receipt
from copy import deepcopy
wrong=deepcopy(receipt);wrong['captureFiles']=[{'original':{'path':'x','bytes':1,'sha256':'a'*64}}]
try: m.validate_receipts(wrong);raise SystemExit('wrapped capture accepted')
except ValueError as e: assert 'captureFiles' in str(e)
wrong=deepcopy(receipt);wrong['trackingReceipt']['stdout']={'path':'x','bytes':1,'sha256':'a'*64}
try: m.validate_receipts(wrong);raise SystemExit('tracking stdio accepted')
except ValueError as e: assert 'trackingReceipt' in str(e)
wrong=deepcopy(receipt);wrong['commandReceipt']['actualWait']=False
try: m.validate_receipts(wrong);raise SystemExit('no wait accepted')
except ValueError as e: assert 'wait' in str(e)
wrong=deepcopy(receipt);wrong['commandReceipt']['exit']=3
try: m.validate_receipts(wrong);raise SystemExit('nonzero accepted')
except ValueError as e: assert 'exit zero' in str(e)
# 4. Complete member closure: dirs/modes/symlinks/files and NO extras.
out=root/'out';out.mkdir();(out/'bin').mkdir(mode=0o755);(out/'bin/tool').write_bytes(b'ELF')
(out/'lib').mkdir(mode=0o750);(out/'lib/a.so').write_bytes(b'SO')
(out/'link').symlink_to('bin/tool')
after=m.manifest(str(out),check=lambda:None,maximum=1000,roots=(str(out),))
assert set(after)=={'bin','bin/tool','lib','lib/a.so','link'}
assert after['bin']['type']=='directory' and after['bin']['mode']==0o755
assert after['bin/tool']=={'type':'file','mode':0o644,'bytes':3,'sha256':sha(b'ELF')}
assert after['link']['type']=='symlink' and after['link']['bytes']==0 and after['link']['target']=='bin/tool'
m.compare_manifest(after,after)
extra=dict(after);extra['extra.txt']={'type':'file','mode':0o644,'bytes':1,'sha256':'a'*64}
try: m.compare_manifest(after,extra);raise SystemExit('extra output accepted')
except ValueError as e: assert 'unexpected' in str(e)
wrongmode=json.loads(json.dumps(after));wrongmode['bin']['mode']=0o700
try: m.compare_manifest(after,wrongmode);raise SystemExit('dir mode accepted')
except ValueError as e: assert 'mode' in str(e)
wrongtype=json.loads(json.dumps(after));wrongtype['link']={'type':'file','mode':0o777,'bytes':0,'sha256':'a'*64}
try: m.compare_manifest(after,wrongtype);raise SystemExit('type accepted')
except ValueError as e: assert 'type' in str(e)
wrongtarget=json.loads(json.dumps(after));wrongtarget['link']['target']='../outside'
try: m.compare_manifest(after,wrongtarget);raise SystemExit('target accepted')
except ValueError as e: assert 'target' in str(e)
# 5. Shared remaining bound (no arbitrary 8MiB whole-output ceiling).
big=root/'big';big.mkdir();(big/'x').write_bytes(b'x'*100)
try: m.manifest(str(big),check=lambda:None,maximum=50,roots=(str(big),));raise SystemExit('remaining overflow accepted')
except ValueError as e: assert 'exceeds' in str(e)
# 6. FD/named identity mutation during hash rejects.
victim=big/'victim';victim.write_bytes(b'A'*70000);replacement=big/'replacement';replacement.write_bytes(b'B'*70000)
real_read=os.read;calls=[0]
def mutate(fd,count):
    block=real_read(fd,count)
    if block and calls[0]==0:
        calls[0]+=1
        os.replace(replacement,victim)
    return block
try:
    os.read=mutate
    m._stream(str(victim),check=lambda:None,maximum=100000)
    raise SystemExit('fd mutation accepted')
except ValueError as e: assert 'changed during read' in str(e) or 'replaced' in str(e)
finally: os.read=real_read
# 7. Failure budget: ledger rejects claim, original failure is not suppressed.
ledger=m.SharedLedger(check=lambda:None,remaining=lambda:10,reserve=lambda n:(_ for _ in ()).throw(ValueError('shared reserve exhausted')),maximum=10,deadline=1e18)
try:
    ledger.claim({'path':str(root/'out'/'f'),'bytes':1,'sha256':'a'*64},'runtime')
    raise SystemExit('reserve failure accepted')
except ValueError as e: assert 'shared reserve exhausted' in str(e)
assert ledger.bytes==0 and not ledger.paths
# 8. Use only the repository backend. A stale dependency fails explicitly;
# a merged backend validates the same constructor/phase boundary.
import inspect
local, observer=m.load_module('qlever/scripts/sdk-ptrace-execution.py','local_observer','Observer')
local_missing='compressed_raw' not in inspect.signature(observer.__init__).parameters
assert 'compressed_raw' not in inspect.signature(observer.phase).parameters
# Produce preflight fails before fake Observer use for a noncanonical workspace.
try:
    m.produce(observer_module='qlever/scripts/sdk-ptrace-execution.py',
      command_materials_module='qlever/scripts/sdk-command-materials.py',out=str(root/'owned'),
      source='/not/canonical',build='/opt/qlever-sdk',profile_path=str(profile),
      expected_source_sha='2'*40,expected_sdk_image='ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:'+'3'*64,
      source_inventory=inventory,runtime_manifest=after,ledger=ledger,
      run_id=1,run_attempt=1,job='job-1',
      runtime_image='ghcr.io/undefinedsco/xpod@sha256:'+'4'*64,
      runtime_config_digest='sha256:'+'5'*64)
    raise SystemExit('noncanonical workspace accepted')
except ValueError as e:
    # This checkout has the stale Observer without compressed_raw, so produce
    # must fail explicitly before executing anything; never silently downgrade.
    assert ('compressed_raw' if local_missing else 'canonical focused workspace') in str(e), str(e)
print(json.dumps({'schema':True,'receipt':True,'closure':True,'fd':True,'budget':True,'observer':True,'ok':True}))
`;
test('producer actual profile/receipt/closure/fd/budget mechanics',()=>{
 const out=execFileSync('/usr/bin/python3',['-I','-S','-B','-c',worker,producer],{maxBuffer:1024**2}).toString();
 expect(JSON.parse(out)).toEqual({schema:true,receipt:true,closure:true,fd:true,budget:true,observer:true,ok:true});
},20000);
const cli=String.raw`
import json,subprocess,sys,tempfile
from pathlib import Path
script=sys.argv[1]
root=Path(tempfile.mkdtemp())
help_run=subprocess.run([sys.executable,script,'--help'],capture_output=True,text=True)
assert help_run.returncode==0 and '--source-inventory' in help_run.stdout and '--maximum-bytes' in help_run.stdout
run=subprocess.run([sys.executable,script,'--out',str(root/'o'),'--source-inventory',str(root/'i'),'--runtime-manifest',str(root/'r'),
 '--source-sha','a'*40,'--sdk-image','ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:'+'b'*64,'--runtime-image','ghcr.io/undefinedsco/xpod@sha256:'+'c'*64,
 '--runtime-config-digest','sha256:'+'d'*64,'--run-id','1','--run-attempt','1','--job','j','--maximum-bytes',str(129*1024**2),'--deadline-monotonic','1.0'],capture_output=True,text=True)
assert run.returncode!=0 and '128MiB' in run.stderr, run.stderr
run=subprocess.run([sys.executable,script,'--out',str(root/'o2'),'--source-inventory',str(root/'i'),'--runtime-manifest',str(root/'r'),
 '--source-sha','bad','--sdk-image','bad','--runtime-image','bad','--runtime-config-digest','bad','--run-id','1','--run-attempt','1','--job','j','--maximum-bytes','1000','--deadline-monotonic','1.0'],capture_output=True,text=True)
assert run.returncode!=0
print(json.dumps({'help':True,'limit':True,'schema':True}))
`;
test('cli exposes required args and fails closed on limit/schema',()=>{
 const out=execFileSync('/usr/bin/python3',['-I','-S','-B','-c',cli,producer],{maxBuffer:1024**2}).toString();
 expect(JSON.parse(out)).toEqual({help:true,limit:true,schema:true});
},20000);
