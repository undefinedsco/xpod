import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';

it('retains real dependency bytes and detects mutation, added files, and escaping links', () => {
  const code = `import importlib.util,json,pathlib,tempfile,shutil
s=importlib.util.spec_from_file_location('t','scripts/lib/afs-consumer-tool-originals.py')
t=importlib.util.module_from_spec(s);s.loader.exec_module(t)
base=pathlib.Path(tempfile.mkdtemp(prefix='tools-',dir='.test-data')).resolve()
results=[]
try:
 for mutation in ['unchanged','bytes','added','escape']:
  repo=base/mutation;repo.mkdir();out=base/(mutation+'-out');out.mkdir()
  pkg=repo/'node_modules/tool';pkg.mkdir(parents=True)
  (pkg/'package.json').write_text('{"name":"tool","version":"1.0.0"}')
  (pkg/'index.js').write_text('original')
  paths,_,_=t.package_closure(repo,['tool'])
  cap=t.ToolOriginals(out,'a'*40);cap.start_stage()
  component=cap.capture('harness','harness',repo,'dependencies',paths,selector={'kind':'package-closure','seeds':['tool']})
  cap.end_stage()
  assert component['archives'] and (out/component['archives'][0]['path']).is_file()
  if mutation=='bytes': (pkg/'index.js').write_text('modified')
  if mutation=='added': (pkg/'new.js').write_text('new input')
  if mutation=='escape': (pkg/'escaped').symlink_to(base)
  cap.start_stage()
  try:
   ref=cap.observe('after',[]);cap.end_stage()
   assert (out/ref['path']).is_file()
   results.append('accepted')
  except (ValueError,RuntimeError): results.append('rejected')
 print(json.dumps(results))
finally: shutil.rmtree(base)`;
  expect(JSON.parse(execFileSync('python3', [ '-c', code ], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' })))
    .toEqual([ 'accepted', 'rejected', 'rejected', 'rejected' ]);
});

it('rejects an executable alias rebound to different bytes after capture', () => {
  const code = `import importlib.util,json,pathlib,tempfile,shutil
s=importlib.util.spec_from_file_location('t','scripts/lib/afs-consumer-tool-originals.py')
t=importlib.util.module_from_spec(s);s.loader.exec_module(t)
base=pathlib.Path(tempfile.mkdtemp(prefix='tools-',dir='.test-data')).resolve()
try:
 out=base/'out';out.mkdir();binary=base/'binary';binary.write_bytes(b'original tool bytes')
 other=base/'other';other.write_bytes(b'different executable');alias=base/'selected';alias.symlink_to(binary)
 cap=t.ToolOriginals(out,'a'*40);cap.start_stage()
 cap.capture('executables','executables',pathlib.Path('/'),'toolchain',['node'],{'node':{'executable':str(binary),'invokedPath':str(alias)}})
 cap.end_stage();cap.start_stage();cap.observe('before',[]);cap.end_stage()
 alias.unlink();alias.symlink_to(other);cap.start_stage()
 try: cap.observe('after',[]);print('accepted')
 except ValueError: print('rejected')
finally: shutil.rmtree(base)`;
  expect(execFileSync('python3', [ '-c', code ], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' }).trim()).toBe('rejected');
});

it('binds logical install names to their actual internal package root and rejects alias rebinding', () => {
  const code = `import importlib.util,json,pathlib,tempfile,shutil
s=importlib.util.spec_from_file_location('t','scripts/lib/afs-consumer-tool-originals.py');t=importlib.util.module_from_spec(s);s.loader.exec_module(t)
base=pathlib.Path(tempfile.mkdtemp(prefix='tool-alias-',dir='.test-data')).resolve()
try:
 repo=base/'repo';repo.mkdir();out=base/'out';out.mkdir()
 actual=repo/'node_modules/.store/tool';actual.mkdir(parents=True);(actual/'package.json').write_text('{"name":"tool","version":"1.0.0"}');(actual/'index.js').write_text('original')
 alias=repo/'node_modules/tool';alias.symlink_to('.store/tool')
 paths,packages,_=t.package_closure(repo,['tool'])
 assert packages==[{'name':'tool','version':'1.0.0','path':'node_modules/.store/tool','logicalPaths':['node_modules/tool']}]
 cap=t.ToolOriginals(out,'a'*40);cap.start_stage();cap.capture('harness','harness',repo,'dependencies',paths,selector={'kind':'package-closure','seeds':['tool']});cap.end_stage()
 other=repo/'node_modules/.store/other';other.mkdir();(other/'package.json').write_text('{"name":"tool","version":"1.0.0"}');(other/'index.js').write_text('other bytes')
 alias.unlink();alias.symlink_to('.store/other');cap.start_stage()
 try:cap.observe('after',[]);raise AssertionError('rebound alias accepted')
 except ValueError:pass
 print('logical-physical-alias-bound;rebind-rejected')
finally:shutil.rmtree(base)`;
  expect(execFileSync('python3', ['-c', code], {cwd: path.resolve(__dirname, '../..'), encoding: 'utf8'}).trim()).toBe('logical-physical-alias-bound;rebind-rejected');
});
