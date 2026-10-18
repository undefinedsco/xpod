const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'../..');
const canonical=JSON.parse(fs.readFileSync(path.join(root,'package.json')));
for(const file of ['prepare.cjs','preload.cjs'])test('actual '+file+' checks catalog-resolved fixed tooling pin before any install/load',()=>{
 const filename=path.join(root,'.github/tooling/legacy-root-verifier',file),original=fs.readFileSync(filename,'utf8'),realRequire=createRequire(filename);
 // Execute the actual source prefix, stopping at the first operation after its
 // fixed repository pin check. No install or candidate dependency is executed.
 const stop=file==='prepare.cjs'?'  const base =':'  const validatorRequire =';
 const prefix=original.slice(0,original.indexOf(stop));
 for(const [label,manifest,ok] of [['catalog',canonical,true],['legacy',{...canonical,devDependencies:{...canonical.devDependencies,semver:'7.8.5'}},true],['drift',{...canonical,devDependencies:{...canonical.devDependencies,semver:'7.8.4'}},false]]){
  const mockFs={...fs,realpathSync:x=>String(x),readFileSync:x=>String(x)===path.join(root,'package.json')?Buffer.from(JSON.stringify(manifest)):fs.readFileSync(x)};
  const context={JSON,require:name=>name==='node:fs'?mockFs:realRequire(name),__dirname:path.dirname(filename),process:{versions:{node:'22.21.1'},argv:['node',path.join(root,'scripts/release-gate-evidence.cjs'),'verify-root-compat'],env:{NODE_PATH:'/isolated/node_modules'}},module:{exports:{}},console};
  // Preload's source/lock identity check sees the same fixed originals through
  // this isolated fixture. Preserve every actual comparison in the prefix.
  mockFs.readFileSync=x=>{x=String(x);if(x===path.join(root,'package.json'))return Buffer.from(JSON.stringify(manifest));if(x.startsWith('/isolated/'))return fs.readFileSync(path.join(root,'.github/tooling/legacy-root-verifier',path.basename(x)));return fs.readFileSync(x);};
  const code=file==='prepare.cjs'?prefix+'  return true; } module.exports=prepare;':prefix+'  module.exports=true; } catch(error) { throw error; }';
  const run=()=>{vm.runInNewContext(code,context,{filename});return file==='prepare.cjs'?context.module.exports('/isolated'):context.module.exports;};
  if(ok)assert.equal(run(),true,label);else assert.throws(run,/pin differs|dependency contract mismatch/,label);
 }
});
