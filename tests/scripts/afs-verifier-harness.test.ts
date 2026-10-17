import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';

it('creates a real clean Git worktree and preserves its unique inputs when installation fails', () => {
  const code = `import importlib.util,json,pathlib,tempfile,subprocess,shutil
s=importlib.util.spec_from_file_location('a','scripts/lib/afs-module-consumer.py');a=importlib.util.module_from_spec(s);s.loader.exec_module(a)
base=pathlib.Path(tempfile.mkdtemp(prefix='fresh-verifier-',dir='.test-data')).resolve()
repo=base/'repo';repo.mkdir();out=base/'out';out.mkdir();owned=base/'owned';owned.mkdir()
def git(*args): return subprocess.check_output(['/usr/bin/git','-C',str(repo),*args],stderr=subprocess.DEVNULL).decode().strip()
try:
 git('init');git('config','user.name','Tiny');git('config','user.email','tiny@example.invalid')
 names=['bun.lock','scripts/check-dependency-state.ts','packages/xpod-cli/scripts/build-tools-package.ts','packages/xpod-client/scripts/build.ts']+[part.split(' ',1)[1] for part in a.harness.POSTINSTALL.split(' && ')]
 for name in names:
  p=repo/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('tiny original')
 (repo/'package.json').write_text(json.dumps({'scripts':{'postinstall':a.harness.POSTINSTALL},'patchedDependencies':{}}))
 git('add','--','.');git('commit','-qm','tiny source');sha=git('rev-parse','HEAD')
 r=a.Runner.__new__(a.Runner);r.output=out;r.owned=owned;r.records=[];r.result={};r.checked={'roots':[repo]};r.preserve_owned_root=False
 r.plan={'checkout':str(repo),'sourceSha':sha,'node':'/usr/bin/false','bun':'/usr/bin/false','budget':{'estimatedPeakBytes':12*1024**3}}
 observed=[]
 def command(label,argv,env,cwd):
  observed.append(label)
  if label.endswith('-install'): raise RuntimeError('deliberate failure before any package installation')
  result=subprocess.run(argv,cwd=cwd,env=env,capture_output=True,check=True)
  r.records.append({'label':label,'argv':argv,'status':'passed','returncode':0,'waitStatus':'known','rawHandlesClosed':True,'rawClosedBeforeHash':True,'ownedGroupAbsent':True,'raw':[{'stream':'stdout'},{'stream':'stderr'}]})
 r.command=command;r.save=lambda:None
 try:r.prepare_owned_root(owned);raise AssertionError('must fail')
 except RuntimeError as e:assert 'deliberate failure' in str(e)
 workspace=owned/'verifier-harness'
 assert workspace.is_dir() and r.preserve_owned_root and not (workspace/'node_modules').exists()
 assert (out/'verifier-tools/install/inputs/bun.lock').read_bytes()==(repo/'bun.lock').read_bytes()
 assert not (out/'verifier-tools/install/prepared.json').exists() and not (out/'verifier-tools/install/complete.json').exists()
 assert observed==['verifier-harness-checkout','verifier-harness-install']
 # A second attempt may never adopt the failed install tree as fresh evidence.
 try:r.prepare_owned_root(owned);raise AssertionError('must reject existing tree')
 except ValueError as e:assert 'fresh owned worktree' in str(e)
 assert observed==['verifier-harness-checkout','verifier-harness-install']
 default=a.lifecycle.ModuleConsumerRunner.__new__(a.lifecycle.ModuleConsumerRunner)
 assert default.prepare_owned_root(owned) is None and default.finish_owned_root(owned) is None
 print('real-git-fresh-failure-preserved;default-hooks-noop')
finally:
 if (owned/'verifier-harness').exists():git('worktree','remove','--force',str(owned/'verifier-harness'))
 shutil.rmtree(base)`;
  expect(execFileSync('python3', ['-c', code], {cwd: path.resolve(__dirname, '../..'), encoding: 'utf8'}).trim())
    .toBe('real-git-fresh-failure-preserved;default-hooks-noop');
});

it('places the fresh hooks inside the owned lifecycle and preserves only explicitly failed roots', () => {
  const code = `import ast,pathlib
m=ast.parse(pathlib.Path('scripts/lib/module-consumer.py').read_text())
c=next(n for n in m.body if isinstance(n,ast.ClassDef) and n.name=='ModuleConsumerRunner')
f=next(n for n in c.body if isinstance(n,ast.FunctionDef) and n.name=='run')
source=ast.unparse(f)
assert source.index('self.prepare_owned_root(root)') < source.index("for runtime in ['node', 'bun']") < source.index('self.finish_owned_root(root)')
assert 'require(not self.preserve_owned_root' in source
init=ast.unparse(next(n for n in c.body if isinstance(n,ast.FunctionDef) and n.name=='__init__'))
assert 'self.preserve_owned_root = False' in init
print('owned-hook-order-and-default-preservation-verified')`;
  expect(execFileSync('python3', ['-c', code], {cwd: path.resolve(__dirname, '../..'), encoding: 'utf8'}).trim())
    .toBe('owned-hook-order-and-default-preservation-verified');
});
