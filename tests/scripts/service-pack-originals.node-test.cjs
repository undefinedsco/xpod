const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const {createServicePackOriginals}=require('../../scripts/service-pack-originals.cjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixture(run){fs.mkdirSync('.test-data',{recursive:true});const root=fs.mkdtempSync(path.resolve('.test-data/service-pack-originals-'));try{return run(root);}finally{fs.rmSync(root,{recursive:true,force:true});}}
test('same actual returned manifest buffers retain full originals, independent roles and exact physical-byte ledger',()=>fixture(root=>{
 const file=path.join(root,'package.json'),raw=Buffer.from('{"name":"actual","version":"1.2.3"}\n');fs.writeFileSync(file,raw);let charged=0,checks=0;
 const out=path.join(root,'originals'),writer=createServicePackOriginals({directory:out,sourceSha:'a'.repeat(40),check(){checks++;},reserveBytes(n){charged+=n;}});
 assert.equal(writer.readManifest(file,'selected-input').version,'1.2.3');assert.ok(writer.readOriginal(file,'same-bytes-second-actual-read').equals(raw));
 const event={role:'resolution',name:'actual',resolvedRoot:root};writer.event(event);event.resolvedRoot='/mutated-caller';
 const ref=writer.seal({authorityVerified:true,sourceSha:'caller-cannot-override'}),metaRaw=fs.readFileSync(path.join(out,ref.path)),meta=JSON.parse(metaRaw);
 assert.equal(meta.authorityVerified,false);assert.equal(meta.sourceSha,'a'.repeat(40));assert.equal(meta.records[2].resolvedRoot,root);assert.equal(meta.records[0].reference.path,meta.records[1].reference.path);assert.equal(meta.records[0].reference.sha256,hash(raw));assert.equal(meta.records[0].identity.length,6);assert.deepEqual(fs.readFileSync(path.join(out,meta.records[0].reference.path)),raw);assert.equal(charged,raw.length+metaRaw.length);assert.equal(hash(metaRaw),ref.sha256);assert.ok(checks>8);assert.throws(()=>writer.event({}),/sealed/);
}));
test('preexpired, oversized actual originals and retained budget exhaustion never write an unauthorized byte',()=>fixture(root=>{
 assert.throws(()=>createServicePackOriginals({directory:path.join(root,'expired'),sourceSha:'a'.repeat(40),check(){throw Error('same parent deadline');},reserveBytes(){}}),/same parent/);assert.equal(fs.existsSync(path.join(root,'expired')),false);
 const file=path.join(root,'large.json');fs.writeFileSync(file,Buffer.alloc(4*1024*1024+1));const out=path.join(root,'originals'),writer=createServicePackOriginals({directory:out,sourceSha:'a'.repeat(40),check(){},reserveBytes(){throw Error('same retained ledger exhausted');}});
 assert.throws(()=>writer.readOriginal(file,'input'),/bounded regular/);assert.deepEqual(fs.readdirSync(path.join(out,'objects')),[]);
 assert.throws(()=>writer.retainBuffer(Buffer.from('must not write'),'input'),/same retained/);for(const name of fs.readdirSync(path.join(out,'objects')))assert.equal(fs.statSync(path.join(out,'objects',name)).size,0);
}));
test('path replacement during a held-FD read is rejected before registering a false original',()=>fixture(root=>{
 const file=path.join(root,'package.json');fs.writeFileSync(file,'{"name":"first"}');const out=path.join(root,'originals'),writer=createServicePackOriginals({directory:out,sourceSha:'a'.repeat(40),check(){},reserveBytes(){}});const realRead=fs.readSync;let replaced=false;
 fs.readSync=function(...args){const n=realRead.apply(fs,args);if(!replaced){replaced=true;fs.renameSync(file,file+'.old');fs.writeFileSync(file,'{"name":"other"}');}return n;};
 try{assert.throws(()=>writer.readManifest(file,'input'),/identity drift|held\/named parent changed/);}finally{fs.readSync=realRead;}
 assert.deepEqual(fs.readdirSync(path.join(out,'objects')),[]);
}));
test('seed and final retain two physical full bodies even when bytes match',()=>fixture(root=>{
 const file=path.join(root,'pack.tgz'),raw=Buffer.alloc(131073,7);fs.writeFileSync(file,raw);let charged=0;
 const out=path.join(root,'metadata'),body=path.join(root,'bodies');const writer=createServicePackOriginals({directory:out,bodyDirectory:body,sourceSha:'a'.repeat(40),check(){},remainingBytes(){return 1048576-charged;},reserveBytes(n){charged+=n;}});
 const seed=writer.retainBody(file,'seed-npm-pack'),final=writer.retainBody(file,'final-service-pack');assert.notEqual(seed.reference.path,final.reference.path);assert.equal(seed.reference.sha256,hash(raw));assert.equal(charged,2*raw.length);
 for(const ref of [seed.reference,final.reference])assert.deepEqual(fs.readFileSync(path.join(body,'objects',path.basename(ref.path))),raw);
 const ref=writer.seal(),meta=JSON.parse(fs.readFileSync(path.join(out,ref.path)));assert.equal(meta.bodyOriginals.length,2);assert.equal(meta.originals.length,0);assert.equal(meta.authorityVerified,false);
}));
test('insufficient parent body allocation rejects before reading the body',()=>fixture(root=>{
 const file=path.join(root,'pack.tgz');fs.writeFileSync(file,Buffer.alloc(65537));const body=path.join(root,'bodies');const writer=createServicePackOriginals({directory:path.join(root,'metadata'),bodyDirectory:body,sourceSha:'a'.repeat(40),check(){},remainingBytes(){return 65536;},reserveBytes(){throw Error('must not charge');}});
 const read=fs.readSync,write=process.stderr.write;let reads=0,diagnostic='';fs.readSync=function(...args){reads++;return read.apply(fs,args);};process.stderr.write=function(value){diagnostic+=value;return true;};try{assert.throws(()=>writer.retainBody(file,'seed-npm-pack'),/pack-body-retention-budget-exhausted/);}finally{fs.readSync=read;process.stderr.write=write;}assert.equal(reads,0);assert.deepEqual(fs.readdirSync(path.join(body,'objects')),[]);assert.ok(Buffer.byteLength(diagnostic)<2048);const row=JSON.parse(diagnostic.slice('SERVICE_PACK_BODY_BUDGET '.length));assert.equal(row.bytes,65537);assert.equal(row.remainingBytes,65536);assert.equal(row.bodyRetained,false);assert.equal(row.authorityVerified,false);assert.ok(!diagnostic.includes(root));
}));
test('body path replacement cannot register a completed original',()=>fixture(root=>{
 const file=path.join(root,'pack.tgz');fs.writeFileSync(file,Buffer.alloc(65537));const body=path.join(root,'bodies');const writer=createServicePackOriginals({directory:path.join(root,'metadata'),bodyDirectory:body,sourceSha:'a'.repeat(40),check(){},remainingBytes(){return 1048576;},reserveBytes(){}});
 const read=fs.readSync;let changed=false;fs.readSync=function(...args){const n=read.apply(fs,args);if(!changed){changed=true;fs.renameSync(file,file+'.old');fs.writeFileSync(file,Buffer.alloc(65537,1));}return n;};try{assert.throws(()=>writer.retainBody(file,'seed-npm-pack'),/identity changed/);}finally{fs.readSync=read;}assert.equal(fs.readdirSync(path.join(body,'objects')).filter(name=>!name.startsWith('.pending')).length,0);
}));

test('failed diagnostic output preserves the original body-budget refusal',()=>fixture(root=>{
 const file=path.join(root,'pack.tgz');fs.writeFileSync(file,'body');const writer=createServicePackOriginals({directory:path.join(root,'metadata'),bodyDirectory:path.join(root,'bodies'),sourceSha:'a'.repeat(40),check(){},remainingBytes(){return 0;},reserveBytes(){}});const write=process.stderr.write;process.stderr.write=function(){throw Error('broken diagnostic stream');};try{assert.throws(()=>writer.retainBody(file,'seed-npm-pack'),/pack-body-retention-budget-exhausted/);}finally{process.stderr.write=write;}
}));

test('a real dependency-closure record set is accepted, and the new bound still fails closed',()=>fixture(root=>{
 const {OBSERVATION_BOUNDS}=require('../../scripts/service-pack-originals.cjs');
 const limits=require('../../scripts/lib/module-artifact-limits.json');
 // The observed legitimate pack needed 912 records / 6,268,688 transport bytes.
 // The shared module-source bound (512/4MiB) describes single module inputs, so
 // it rejected a real workspace pack. These numbers come from an actual pack on
 // source a7c5a2b3 with the service profile, and each must stay inside the new
 // bound while still exceeding the old one - otherwise the two are one number.
 assert.ok(912<OBSERVATION_BOUNDS.records);
 assert.ok(6268688<=OBSERVATION_BOUNDS.metadataBytes);
 assert.ok(912>limits.sourceMaterialFiles);
 assert.ok(6268688>limits.metadataBytes);

 const out=path.join(root,'originals');
 const writer=createServicePackOriginals({directory:out,sourceSha:'a'.repeat(40),check(){},reserveBytes(){}});
 // 912 real-shaped resolution rows are accepted (old 512 bound would reject).
 for(let i=0;i<912;i++)writer.event({role:'actual-node-resolution',name:'dep-'+i,source:root,searchRoots:[root],globalPaths:[],workerPid:1,probes:[{path:root+'/x',exists:i===0}],resolvedRoot:null});
 const sealed=writer.seal();
 const meta=JSON.parse(fs.readFileSync(path.join(out,sealed.path)));
 assert.equal(meta.records.length,912);
 // The bound is still a bound: record number 2048 cannot be added.
 const capped=createServicePackOriginals({directory:path.join(root,'capped'),sourceSha:'a'.repeat(40),check(){},reserveBytes(){}});
 for(let i=0;i<OBSERVATION_BOUNDS.records;i++)capped.event({role:'actual-node-resolution',name:'d'+i,source:root,searchRoots:[root],globalPaths:[],workerPid:1,probes:[{path:root,exists:true}],resolvedRoot:null});
 assert.throws(()=>capped.event({role:'actual-node-resolution',name:'overflow',source:root,searchRoots:[root],globalPaths:[],workerPid:1,probes:[],resolvedRoot:null}),/bounded original record count/);
}));

test('aggregate transport bound is behaviourally live: >old 4MiB seals, >new 8MiB rejects',()=>fixture(root=>{
 // The record-wall fixture above stays far under BOTH aggregate transport
 // bounds, so on its own it cannot catch a partial revert that puts only the
 // transport comparison back to limits.metadataBytes (4MiB) while the exported
 // OBSERVATION_BOUNDS object still advertises 8MiB. Drive the transport wall
 // with a small number of large DISTINCT originals.
 const {OBSERVATION_BOUNDS}=require('../../scripts/service-pack-originals.cjs');
 const limits=require('../../scripts/lib/module-artifact-limits.json');
 const SIZE=256*1024;                       // well under the 4MiB per-original cap
 const ACROSS=SIZE*25;                      // 6.4MiB: > old 4MiB, < new 8MiB
 assert.ok(ACROSS>limits.metadataBytes);
 assert.ok(ACROSS<OBSERVATION_BOUNDS.metadataBytes);
 assert.ok(SIZE<=limits.metadataBytes);     // per-original bound unchanged

 // Positive: 25 distinct 256KiB originals really append AND seal.
 const out=path.join(root,'across');
 const across=createServicePackOriginals({directory:out,sourceSha:'a'.repeat(40),check(){},reserveBytes(){}});
 for(let i=0;i<25;i++)across.retainBuffer(Buffer.alloc(SIZE,i+1),'distinct-'+i);
 const sealed=across.seal();
 const meta=JSON.parse(fs.readFileSync(path.join(out,sealed.path)));
 assert.equal(meta.records.length,25);
 assert.equal(meta.originals.length,25);
 assert.ok(meta.originals.every(row=>row.bytes===SIZE));
 // 25 distinct contents => 25 distinct retained objects, so the transport
 // projection really tops the old bound instead of deduplicating to one object.
 assert.equal(new Set(meta.originals.map(row=>row.sha256)).size,25);
 const sealedBytes=meta.originals.reduce((sum,row)=>sum+row.bytes,0);
 assert.ok(sealedBytes>limits.metadataBytes&&sealedBytes<OBSERVATION_BOUNDS.metadataBytes);

 // Negative: crossing the NEW bound still fails closed with the exact reason.
 const over=createServicePackOriginals({directory:path.join(root,'over'),sourceSha:'a'.repeat(40),check(){},reserveBytes(){}});
 assert.throws(()=>{
  for(let i=0;i<34;i++)over.retainBuffer(Buffer.alloc(SIZE,i+1),'over-'+i);
  over.seal();
 },/metadata transport aggregate bound/);
}));
