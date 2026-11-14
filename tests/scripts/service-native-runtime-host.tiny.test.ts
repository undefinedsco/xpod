/** Host CLI mechanics only; no Docker/build execution or fake source cap. */
import{test,expect}from'bun:test';
import{execFileSync}from'node:child_process';
const host='qlever/scripts/sdk-service-native-runtime-host.py';
const worker=String.raw`
import hashlib,importlib.util,inspect,json,os,subprocess,sys,tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('host',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(os.path.realpath(tempfile.mkdtemp()))
help_run=subprocess.run([sys.executable,sys.argv[1],'--help'],capture_output=True,text=True)
assert help_run.returncode==0
for flag in ['--source-sha','--sdk-image','--runtime-image','--run-id','--run-attempt','--job','--out','--deadline-monotonic','--maximum-bytes']:
    assert flag in help_run.stdout,flag
# Argument validation, no docker.
def argv(out,**over):
    value=dict(source_sha='1'*40,sdk_image='ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:'+'2'*64,
      runtime_image='ghcr.io/undefinedsco/xpod-qlever-local-runtime@sha256:'+'3'*64,
      run_id='1',run_attempt='1',job='job-1',out=str(out),deadline_monotonic=str(__import__('time').monotonic()+120),maximum_bytes=str(128*1024*1024))
    value.update(over)
    args=[]
    for key,item in value.items():args+=['--'+key.replace('_','-'),item]
    return args
try: m.parse_args(argv(root/'x',maximum_bytes=str(129*1024*1024)));raise SystemExit('oversize accepted')
except ValueError as e: assert '128MiB' in str(e)
try: m.parse_args(argv(root/'x',source_sha='bad'));raise SystemExit('bad sha accepted')
except ValueError as e: assert 'source SHA' in str(e)
try: m.parse_args(argv(root/'x',deadline_monotonic='nan'));raise SystemExit('nan accepted')
except ValueError as e: assert 'deadline' in str(e)
(root/'exists').write_text('x')
try: m.parse_args(argv(root/'exists'));raise SystemExit('existing out accepted')
except ValueError as e: assert 'fresh non-linked output' in str(e)
(root/'link').symlink_to(root/'exists')
try: m.parse_args(argv(root/'link'));raise SystemExit('linked out accepted')
except ValueError as e: assert 'fresh non-linked output' in str(e)
args=m.parse_args(argv(root/'fresh'))
assert args.run_id==1 and args.run_attempt==1 and args.maximum_bytes==128*1024*1024
# Peak budget shares one bound.
b=m.PeakBudget(100,__import__('time').monotonic()+120)
b.reserve(40)
assert b.remaining()==60
try: b.reserve(61);raise SystemExit('overflow accepted')
except ValueError as e: assert 'budget exceeded' in str(e)
assert b.bytes==40
# Git inventory enumerates only tracked listed dirs; deterministic repo fixture.
repo=root/'repo';(repo/'qlever/scripts').mkdir(parents=True);(repo/'qlever/scripts/run-focused-native-build.sh').write_bytes(b'#!/bin/bash\n');(repo/'qlever/scripts/extra.txt').write_bytes(b'extra')
subprocess.run(['git','init','-q',str(repo)],check=True,env={**os.environ,'GIT_CONFIG_GLOBAL':'/dev/null','GIT_CONFIG_NOSYSTEM':'1'})
subprocess.run(['git','-C',str(repo),'add','qlever/scripts/run-focused-native-build.sh','qlever/scripts/extra.txt'],check=True)
subprocess.run(['git','-C',str(repo),'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],check=True)
head=subprocess.run(['git','-C',str(repo),'rev-parse','HEAD'],capture_output=True,text=True,check=True).stdout.strip()
budget=m.PeakBudget(1024*1024,__import__('time').monotonic()+120)
real_run_stage=None
calls=[]
class Receipt(dict):
    pass
def fake_stage(name,command,evidence,cwd,**kw):
    calls.append((name,command))
    evidence=Path(evidence);evidence.mkdir(parents=True,exist_ok=True)
    if name=='host-git-head': raw=(head+'\n').encode()
    elif name=='host-git-ls-files': raw=b'qlever/scripts/run-focused-native-build.sh\0qlever/scripts/extra.txt\0'
    else: raise AssertionError(name)
    path=evidence/(name+'.raw.log');path.write_bytes(raw)
    return dict(command=command,pid=1,pgid=1,actualWait=True,exit=0,signal=None,
      rawClosedBeforeHash=True,ownedGroupAbsentAfterWait=True,rawSHA256=hashlib.sha256(raw).hexdigest(),
      resourceStop=None,cleanupErrors=[],supervisorError=None),raw.decode()
rows=m.git_source_inventory(repo,stage=fake_stage,budget=budget,evidence=root/'ev')
assert len(rows)==2 and all(row['path'].startswith('./qlever/scripts/') for row in rows)
assert rows[0]['sha256']==hashlib.sha256(b'#!/bin/bash\n').hexdigest() or rows[1]['sha256']==hashlib.sha256(b'#!/bin/bash\n').hexdigest()
assert calls[0][0]=='host-git-ls-files' and calls[0][1][:4]==['git','-C',str(repo),'ls-files'] and calls[0][1][4]=='-z',calls
# Path traversal is not returned by real git, but a malicious fixture row is rejected.
def bad_stage(name,command,evidence,cwd,**kw):
    raw=b'../escape\0'
    return dict(command=command,pid=1,pgid=1,actualWait=True,exit=0,signal=None,
      rawClosedBeforeHash=True,ownedGroupAbsentAfterWait=True,rawSHA256=hashlib.sha256(raw).hexdigest(),
      resourceStop=None,cleanupErrors=[],supervisorError=None),raw.decode()
try:
    m.git_source_inventory(repo,stage=bad_stage,budget=m.PeakBudget(1024*1024,__import__('time').monotonic()+120),evidence=root/'ev2')
    raise SystemExit('traversal accepted')
except ValueError as e: assert 'safe tracked source path' in str(e)
# Manifest helper derives actual dirs/links/files from a tree.
tree=root/'runtime';(tree/'bin').mkdir(parents=True);(tree/'bin/run').write_bytes(b'ELF')
(tree/'link').symlink_to('bin/run')
manifest=m.load_inner().manifest(str(tree),check=lambda:None,maximum=1024*1024,roots=(str(tree),))
assert manifest['bin']['type']=='directory' and manifest['bin/run']['type']=='file'
assert manifest['link']['type']=='symlink' and manifest['link']['target']=='bin/run'
# Fixed source declaration covers both the copied tree and the Dockerfile that constructs it.
# Reviewed legal V13 added the repository's authoritative ancestor LICENSE to the
# workspace COPY scope, so the host inventory must enumerate it too. Fixtures
# follow production (AGENTS.md native-fixture contract), never the reverse.
assert m.SOURCE_DIRS==('LICENSE','qlever/cmake','qlever/include','qlever/qlever.lock.json','qlever/patches','qlever/qlever_adapter','qlever/qlever_local_runtime','qlever/rdf_protocol','qlever/rdf_sqlite_backend','qlever/scripts','docker/qlever-local-runtime/Dockerfile')
assert m.INNER=='/workspace/xpod/qlever/scripts/sdk-service-native-runtime-originals.py'
assert 'SYS_PTRACE' in inspect.getsource(m.create_builder) and 'seccomp=unconfined' in inspect.getsource(m.create_builder)
assert 'run_stage' in inspect.getsource(m.run) or 'stage(' in inspect.getsource(m.run)
print(json.dumps({'args':True,'budget':True,'inventory':True,'manifest':True,'fixed':True,'ok':True}))
`;
test('host CLI validates args, enumerates tracked source, derives manifest, uses fixed inner contract',()=>{
 const out=execFileSync('/usr/bin/python3',['-I','-S','-B','-c',worker,host],{maxBuffer:4*1024**2,timeout:60000}).toString();
 expect(JSON.parse(out)).toEqual({args:true,budget:true,inventory:true,manifest:true,fixed:true,ok:true});
},60000);
