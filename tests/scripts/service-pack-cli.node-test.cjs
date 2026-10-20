const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {execFileSync,spawnSync}=require('node:child_process'),{createRequire}=require('node:module');
const source=path.resolve(__dirname,'../../scripts/run-npm-pack.cjs');
test('actual retained pack CLI initializes once and seals seed/final originals through real tiny tar commands',()=>{
 fs.mkdirSync('.test-data',{recursive:true});const root=fs.mkdtempSync(path.resolve('.test-data/service-pack-cli-'));
 try{
  const sandbox={require:createRequire(source),module:{exports:{}},process,console,Buffer};vm.runInNewContext(fs.readFileSync(source,'utf8')+'\nmodule.exports.fixturePackages=PATCHED_RUNTIME_PACKAGES;',sandbox,{filename:source});
  const json=(p,v)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(v));};
  json(path.join(root,'package.json'),{name:'tiny-pack',version:'1.0.0'});
  for(const name of [...sandbox.module.exports.fixturePackages,'@undefineds.co/drizzle-solid']){const pkg=path.join(root,'node_modules',...name.split('/'));json(path.join(pkg,'package.json'),{name,version:'1.0.0',main:'index.js'});fs.writeFileSync(path.join(pkg,'index.js'),'module.exports=1;');}
  const bin=path.join(root,'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'npm'),'#!/usr/bin/env node\nconst fs=require("node:fs"),path=require("node:path"),{execFileSync}=require("node:child_process");const out=process.argv[process.argv.indexOf("--pack-destination")+1];fs.mkdirSync(out,{recursive:true});fs.mkdirSync("seed/package",{recursive:true});fs.copyFileSync("package.json","seed/package/package.json");fs.mkdirSync("seed/package/dist/runtime",{recursive:true});fs.writeFileSync("seed/package/dist/runtime/service-entry.js","module.exports=1;");execFileSync("tar",["czf",path.join(out,"tiny.tgz"),"-C","seed","package"]);process.stdout.write(JSON.stringify([{filename:"tiny.tgz"}]));\n',{mode:0o755});
  fs.mkdirSync(path.join(root,'.test-data'));const result=spawnSync(process.execPath,[source,'.test-data/service-pack','.test-data/service-pack-cache','service','--retain-service-originals','a'.repeat(40),String(Date.now()+60000),String(120*1024**2)],{cwd:root,env:{...process.env,PATH:bin+path.delimiter+process.env.PATH},encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
  assert.equal(result.status,0,result.stderr);const record=JSON.parse(fs.readFileSync(path.join(root,'.test-data/service-pack-originals/materials.json')));assert.equal(record.details.completion,'actual-pack-returned');assert.equal(record.authorityVerified,false);assert.deepEqual(record.records.filter(r=>r.kind==='actual-pack-body').map(r=>r.role),['seed-npm-pack','public-package-tar','final-service-pack']);assert.equal(record.bodyOriginals.length,3);
  const out=path.join(root,'unpacked');fs.mkdirSync(out);execFileSync('tar',['xf',path.join(root,'.test-data/service-pack/tiny.tgz'),'-C',out]);assert.equal(JSON.parse(fs.readFileSync(path.join(out,'package/package.json'))).xpodArtifactProfile,'service');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
