import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

describe('installed inputs remain immutable while TypeScript owns its build cache', () => {
  it('reproduces actual tsc -b dependency drift, then preserves the input set, build-info validity and optional incremental reuse at the corrected location', () => {
    const compiler = process.env.XPOD_UI_TSC_BIN ?? createRequire(path.resolve('ui/package.json')).resolve('typescript/bin/tsc');
    const version = JSON.parse(readFileSync(path.resolve(compiler, '../../package.json'), 'utf8')).version;
    expect(version).toBe(JSON.parse(readFileSync('ui/package.json', 'utf8')).devDependencies.typescript.replace(/^~/u, ''));
    mkdirSync('.test-data/module-source-dependency-drift', {recursive: true});
    const root = mkdtempSync(path.resolve('.test-data/module-source-dependency-drift/case-'));
    try {
      const raw = execFileSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', String.raw`
import importlib.util,json,pathlib,subprocess,sys
root=pathlib.Path(sys.argv[1]);compiler=sys.argv[2];node=sys.argv[3]
spec=importlib.util.spec_from_file_location('materials',sys.argv[4]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
result={}
for label in ['old','fixed']:
 repo=root/label;repo.mkdir();(repo/'node_modules/example').mkdir(parents=True);(repo/'node_modules/example/index.js').write_text('module.exports=1;\n')
 out=root/(label+'-evidence');out.mkdir();materials=out/'source-materials';materials.mkdir()
 inputs={'source':{'inventories':[]},'toolchain':{'inventories':[]}}
 inputs['dependencies']=m.capture_group(materials,out,'dependencies',[(name,repo/name) for name in m.dependency_paths(repo)],repo)
 original_inventories={ref['path']:(out/ref['path']).read_bytes() for ref in inputs['dependencies']['inventories']}
 (repo/'tsconfig.json').write_text(json.dumps({'files':[],'references':[{'path':'./tsconfig.app.json'},{'path':'./tsconfig.node.json'}]}))
 configs=[]
 for name in ['app','node']:
  owned=json.loads(sys.argv[5])[name]
  assert owned=='./.test-data/typescript/tsconfig.'+name+'.tsbuildinfo'
  location=owned if label=='fixed' else './node_modules/.tmp/tsconfig.'+name+'.tsbuildinfo'
  (repo/(name+'.ts')).write_text('export const value=1;\n')
  (repo/('tsconfig.'+name+'.json')).write_text(json.dumps({'compilerOptions':{'tsBuildInfoFile':location,'target':'ES2021','noEmit':True,'types':[]},'files':[name+'.ts']}));configs.append(repo/location)
 before=m.dependency_paths(repo)
 run=subprocess.run([node,compiler,'-b'],cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.PIPE);assert run.returncode==0,(run.stdout,run.stderr)
 after=m.dependency_paths(repo)
 try:m.revalidate_inputs(repo,out,inputs)
 except ValueError as error:
  assert label=='old' and 'Installed dependency input set changed' in str(error)
  delta=json.loads((out/'evidence/source-dependency-set-delta.json').read_text());assert delta['added']['count']==2 and delta['removed']['count']==0
 else:assert label=='fixed'
 assert all((out/name).read_bytes()==data for name,data in original_inventories.items())
 identities=[(p.read_bytes(),p.stat().st_mtime_ns) for p in configs]
 second=subprocess.run([node,compiler,'-b','--verbose'],cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.PIPE);assert second.returncode==0
 assert all(p.read_bytes()==identity[0] and json.loads(p.read_bytes())['version']=='5.9.3' for p,identity in zip(configs,identities))
 # Existing UI noEmit configuration has no incremental flag: preserve its actual
 # rebuild semantics. A separate tiny option check proves the relocated path
 # also supports real incremental reuse without changing the UI settings.
 for name in ['app','node']:
  config=repo/('tsconfig.'+name+'.json');value=json.loads(config.read_text());value['compilerOptions']['incremental']=True;config.write_text(json.dumps(value))
 enabled=subprocess.run([node,compiler,'-b'],cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.PIPE);assert enabled.returncode==0
 identities=[(p.read_bytes(),p.stat().st_mtime_ns) for p in configs]
 cached=subprocess.run([node,compiler,'-b','--verbose'],cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.PIPE);assert cached.returncode==0
 assert all((p.read_bytes(),p.stat().st_mtime_ns)==identity for p,identity in zip(configs,identities))
 assert cached.stdout.count(b'is up to date')==2,cached.stdout
 assert m.dependency_paths(repo)==after
 if label=='fixed':
  removed_out=root/'removed-evidence';removed_out.mkdir();(removed_out/'source-materials').mkdir()
  for name,data in original_inventories.items():(removed_out/name).write_bytes(data)
  (repo/'node_modules/example/index.js').unlink()
  try:m.revalidate_inputs(repo,removed_out,inputs)
  except ValueError as error:
   assert 'Installed dependency input set changed' in str(error)
   removed=json.loads((removed_out/'evidence/source-dependency-set-delta.json').read_text());assert removed['removed']['paths']==['node_modules/example/index.js']
  else:raise AssertionError('removed installed dependency was accepted')
 result[label]={'added':sorted(set(after)-set(before)),'removed':sorted(set(before)-set(after)),'secondBuildSucceeded':True,'explicitIncrementalCacheUpToDate':True}
print(json.dumps(result))
`, root, compiler, process.execPath, path.resolve('scripts/lib/module-source-materials.py'), JSON.stringify(Object.fromEntries(['app', 'node'].map(name => [name, ts.parseConfigFileTextToJson('tsconfig.' + name + '.json', readFileSync('ui/tsconfig.' + name + '.json', 'utf8')).config.compilerOptions.tsBuildInfoFile])))], {encoding: 'utf8'});
      expect(JSON.parse(raw)).toEqual({old: {added: ['node_modules/.tmp/tsconfig.app.tsbuildinfo', 'node_modules/.tmp/tsconfig.node.tsbuildinfo'], removed: [], secondBuildSucceeded: true, explicitIncrementalCacheUpToDate: true}, fixed: {added: [], removed: [], secondBuildSucceeded: true, explicitIncrementalCacheUpToDate: true}});
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
  it('bounds diagnostic paths while hashing the complete sets and preserves before originals', () => {
    mkdirSync('.test-data/module-source-dependency-drift', {recursive: true});
    const root = mkdtempSync(path.resolve('.test-data/module-source-dependency-drift/diagnostic-'));
    try {
      const output = execFileSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', String.raw`
import importlib.util,json,pathlib,sys
spec=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
out=pathlib.Path(sys.argv[2]);before=['node_modules/removed.js'];after=['node_modules/added-'+str(i)+'.js' for i in range(1000)]
ref=m.dependency_set_delta(out,before,after,[]);value=json.loads((out/ref['path']).read_text())
assert value['before']['count']==1 and value['after']['count']==1000 and value['added']['count']==1000 and value['removed']['count']==1
assert len(value['added']['paths'])+len(value['removed']['paths'])<=128 and value['added']['truncated']
assert ref['sha256']==m.digest(out/ref['path']) and ref['bytes']<=m.LIMITS['metadataBytes']
print(json.dumps({'truncated':value['added']['truncated'],'hash':ref['sha256']}))
`, path.resolve('scripts/lib/module-source-materials.py'), root], {encoding: 'utf8', env: {...process.env, SECRET_MARKER: 'must-not-appear-in-diagnostic'}});
      expect(JSON.parse(output).truncated).toBe(true);
      expect(readFileSync(path.join(root, 'evidence/source-dependency-set-delta.json'), 'utf8')).not.toContain('must-not-appear-in-diagnostic');
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
});
