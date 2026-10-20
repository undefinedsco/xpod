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
 try{assert.throws(()=>writer.readManifest(file,'input'),/identity drift/);}finally{fs.readSync=realRead;}
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
