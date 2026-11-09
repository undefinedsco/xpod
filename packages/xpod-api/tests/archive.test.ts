import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {writePhysicalModuleArchive,packPhysicalModule} from '../../../scripts/lib/physical-module-archive';
test('real tar uses exact normalized ModuleStore modes without changing originals',()=>{
 const base=path.resolve('.test-data/api-stage-tests');mkdirSync(base,{recursive:true});const root=mkdtempSync(path.join(base,'tar-'));
 try {
  const stage=path.join(root,'stage');mkdirSync(stage);writeFileSync(path.join(stage,'owner-executable'),'original');chmodSync(path.join(stage,'owner-executable'),0o744);writeFileSync(path.join(stage,'regular'),'original');chmodSync(path.join(stage,'regular'),0o640);
  writeFileSync(path.join(stage,'package.json'),JSON.stringify({name:`@undefineds.co/xpod-api-${process.platform}-${process.arch}`,version:'0.0.0-preview.1',private:true}));
  const output=path.join(root,'actual.tgz');const packed=packPhysicalModule(stage,output,{moduleId:'api',entry:'owner-executable'});assert.equal(packed.members,3);assert.match(packed.sha256,/^[a-f0-9]{64}$/u);assert.match(packed.integrity,/^sha512-/u);
  const check=spawnSync('python3',['-c',`import tarfile,pathlib,sys
with tarfile.open(sys.argv[1]) as t:
 assert t.getmember('package/owner-executable').mode==0o755
 assert all(m.uid==0 and m.gid==0 and m.uname=='' and m.gname=='' and m.mtime==0 for m in t.getmembers())
 assert t.getmember('package/regular').mode==0o644
 assert t.extractfile('package/owner-executable').read()==b'original'
assert pathlib.Path(sys.argv[2],'owner-executable').stat().st_mode & 0o777==0o744
`,output,stage],{encoding:'utf8'});assert.equal(check.status,0);
  assert.throws(()=>writePhysicalModuleArchive(stage,output),/fresh archive/);
 } finally {rmSync(root,{recursive:true,force:true});}
});
