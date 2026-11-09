import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { verifyModuleSourceOriginals, moduleSourceMaterialView } from '../../scripts/lib/independent-admission/module-source-admission';

const parent = path.resolve('.test-data/module-source-admission'); mkdirSync(parent, { recursive: true });
const root = mkdtempSync(path.join(parent, 'tiny-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const script = `import importlib.util,pathlib,sys,json,os,shutil
spec=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
r=pathlib.Path(sys.argv[2]); repo=r/'repo';repo.mkdir();out=r/'out';out.mkdir();materials=out/'source-materials';materials.mkdir()
(repo/'entry.ts').write_text('export const answer = 42;\\n');(repo/'AGENTS.md').write_text('principles\\n');os.symlink('AGENTS.md',repo/'CLAUDE.md')
dep=repo/'node_modules'/'example';dep.mkdir(parents=True);(dep/'index.js').write_text('module.exports=42;\\n');(dep/'package.json').write_text('{"name":"example","version":"1.0.0","license":"MIT"}')
os.symlink('example',repo/'node_modules'/'alias')
value={'schemaVersion':1,'kind':'module-source-build-originals','phases':[],'archive':{'sha256':'product'}}
value['source']=m.capture_group(materials,out,'source',[(n,repo/n) for n in ['AGENTS.md','CLAUDE.md','entry.ts']],repo)
value['dependencies']=m.capture_group(materials,out,'dependencies',[(n,repo/n) for n in m.dependency_paths(repo)],repo)
tool=r/'tool';tool.write_text('tiny actual executable original');tool.chmod(0o755)
bin=r/'bin';bin.mkdir()
for n in ['bun','node','python3','git']:os.symlink(str(tool),bin/n)
os.environ['PATH']=str(bin)
value['toolchain']=m.capture_group(materials,out,'toolchain',[(n,tool) for n in ['bun','node','python3','git']],r,{n:{'executable':str(tool),'version':'tiny-1'} for n in ['bun','node','python3','git']})
compiler=json.dumps({'compiledSources':[{'source':'entry.ts','sourceSHA256':m.digest(repo/'entry.ts'),'output':'entry.js','outputSHA256':m.hashlib.sha256(b'out!').hexdigest()}]}).encode();(out/'compiler.json').write_bytes(compiler)
rows=[{'path':'provenance/compiler.json','bytes':len(compiler),'sha256':m.hashlib.sha256(compiler).hexdigest(),'mode':420},{'path':'entry.js','bytes':4,'sha256':m.hashlib.sha256(b'out!').hexdigest(),'mode':420}]
p=materials/'outputs-0000.json';p.write_text(json.dumps(rows));value['outputs']=[m.ref(p,out)]
value['revalidation']=m.revalidate_inputs(repo,out,value)
(materials/'materials.json').write_text(json.dumps(value))
# A real same-path dependency mutation must fail the post-build rehash.
bad=r/'changed-out';shutil.copytree(out,bad)
for domain in ['source','dependencies','toolchain']:
 for ref in value['revalidation'][domain]:(bad/ref['path']).unlink()
(dep/'index.js').write_text('changed input')
try:m.revalidate_inputs(repo,bad,value)
except ValueError as e:assert 'changed' in str(e)
else:raise AssertionError('mutated actual build input accepted')
(dep/'index.js').write_text('module.exports=42;\\n')
# Never follow a dependency symlink to an external secret.
os.symlink(str(r/'tool'),dep/'external')
try:m.capture_group(materials,out,'dependencies-bad',[("node_modules/example/external",dep/'external')],repo)
except ValueError:pass
else:raise AssertionError('external dependency link was captured')
`;
execFileSync('/usr/bin/python3', ['-I', '-B', '-c', script, path.resolve('scripts/lib/module-source-materials.py'), root]);
const output = path.join(root, 'out');
const materials = JSON.parse(readFileSync(path.join(output, 'source-materials/materials.json'), 'utf8'));
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const inventory = readdirSync(path.join(output, 'source-materials')).map(name => {
    const bytes = readFileSync(path.join(output, 'source-materials', name));
    return { path: 'source-materials/' + name, bytes: bytes.length, sha256: digest(bytes) };
  });
  return { materials: structuredClone(materials), producer: { phases: [], archive: { sha256: 'product' } }, inventory,
    members: JSON.parse(readFileSync(path.join(output, 'source-materials/outputs-0000.json'), 'utf8')),
    trackedPaths: ['AGENTS.md', 'CLAUDE.md', 'entry.ts'],
    readTrackedObject: (name: string) => ({ mode: name === 'CLAUDE.md' ? '120000' : '100644', bytes: name === 'CLAUDE.md' ? Buffer.from('AGENTS.md') : readFileSync(path.join(root, 'repo', name)) }),
    readOriginal: (name: string, max: number) => { const b = readFileSync(path.join(output, name)); if (b.length > max) throw Error('limit'); return b; },
    compilerOriginal: readFileSync(path.join(output, 'compiler.json')),
    readRange: (name: string, offset: number, length: number) => readFileSync(path.join(output, name)).subarray(offset, offset + length),
  };
}
describe('restorable module source originals', () => {
  it('binds complete Git objects, installed dependency and tool bytes to exact product outputs', () => {
    const result = verifyModuleSourceOriginals(fixture());
    expect(result.readDependencyOriginal('node_modules/alias/index.js', 100).toString()).toBe('module.exports=42;\n');
    expect(result.readDependencyOriginalRange('node_modules/alias/index.js', 7, 7).toString()).toBe('exports');
    expect(() => result.readDependencyOriginalRange('node_modules/alias/index.js', 0, 65537)).toThrow('range bound');
    expect(() => result.readDependencyOriginalRange('node_modules/alias/index.js', 19, 1)).toThrow('range bound');
    expect(result.transpiledOutputs).toEqual([{ path: 'entry.js', sourcePath: 'entry.ts' }]);
    expect(result.scope).toBe('controlled-recipe-input-universe');
    expect(moduleSourceMaterialView(result)).toBeUndefined();
    result.compactOriginalReaders();
    expect(() => result.readDependencyOriginal('node_modules/alias/index.js', 100)).toThrow('compacted');
    expect(() => result.readDependencyOriginalRange('node_modules/alias/index.js', 0, 1)).toThrow('compacted');
  });
  it('rejects a same-source different product and omitted tracked inputs', () => {
    const different = fixture(); different.members.find((row: any) => row.path === 'entry.js').sha256 = '0'.repeat(64);
    expect(() => verifyModuleSourceOriginals(different)).toThrow('actual build output');
    const omitted = fixture(); omitted.trackedPaths.push('omitted.ts');
    expect(() => verifyModuleSourceOriginals(omitted)).toThrow('complete immutable Git tree');
  });
  it('rejects changed original dependency bytes and a different build receipt', () => {
    const changed = fixture(), read = changed.readRange;
    changed.readRange = (name, offset, length) => {
      const bytes = Buffer.from(read(name, offset, length));
      if (name.includes('dependencies-0000.tar') && offset <= 1024 && offset + bytes.length > 1024) bytes[1024 - offset] = bytes[1024 - offset]! ^ 1;
      return bytes;
    };
    expect(() => verifyModuleSourceOriginals(changed)).toThrow('tar original digest');
    const phase = fixture(); phase.materials.phases = [{ name: 'pretend' }];
    expect(() => verifyModuleSourceOriginals(phase)).toThrow('build/archive receipt binding');
  });
  it('scopes initial verification budget to verification, preserving later original-reader leases',()=>{let remaining=120000;const result=verifyModuleSourceOriginals({...fixture(),budget:{remainingMilliseconds:()=>remaining}});remaining=0;expect(result.readDependencyOriginal('node_modules/alias/index.js',100).toString()).toBe('module.exports=42;\n');expect(()=>verifyModuleSourceOriginals({...fixture(),budget:{remainingMilliseconds:()=>0}})).toThrow('verification deadline');});
});
