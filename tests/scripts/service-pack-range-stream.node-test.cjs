'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{Readable}=require('node:stream');
const {execFileSync}=require('node:child_process');
const {inspectTarballFile,inspectTarballStream}=require('../../scripts/workspace-package-payload.cjs');
const limits={expandedBytes:1024*1024,members:100,manifestBytes:128*1024};
test('file and private-range transports use exactly the same bounded tar manifest parser',async()=>{
 fs.mkdirSync('.test-data',{recursive:true});const root=fs.mkdtempSync(path.resolve('.test-data/service-pack-stream-'));
 try{
  fs.mkdirSync(path.join(root,'package'));const raw=Buffer.from('{"name":"actual","version":"1.0.0"}\n');fs.writeFileSync(path.join(root,'package/package.json'),raw);fs.writeFileSync(path.join(root,'package/payload'),'actual payload');const tar=path.join(root,'actual.tgz');execFileSync('tar',['czf',tar,'-C',root,'package']);
  const body=fs.readFileSync(tar),file=await inspectTarballFile(tar,limits),stream=await inspectTarballStream(Readable.from((function*(){for(let at=0;at<body.length;at+=17)yield body.subarray(at,at+17);})()),limits);
  assert.deepEqual(stream,file);assert.deepEqual(stream.manifestOriginal,raw);
  const result=await inspectTarballStream(Readable.from([body]),limits,undefined,{path:'package/payload',offset:2,length:5});
  assert.deepEqual(result.memberRange,Buffer.from('tual '));
  for (const visitor of [async()=>{},async()=>{throw new Error('late validation failure');},()=>({then(resolve,reject){reject(new Error('late thenable failure'));}})]) {
    await assert.rejects(inspectTarballStream(Readable.from([body]),limits,undefined,undefined,visitor),/must complete synchronously/);
  }
  await new Promise(resolve=>setImmediate(resolve));
  let visited=0;
  await inspectTarballStream(Readable.from([body]),limits,undefined,undefined,()=>{visited++;});
  assert.ok(visited>0);

  await assert.rejects(inspectTarballStream(Readable.from([body]),limits,undefined,{path:'package/payload',offset:0,length:65537}),/Bounded member range/);
  await assert.rejects(inspectTarballStream(Readable.from([body]),limits,undefined,{path:'package/missing',offset:0,length:0}),/missing/);
  await assert.rejects(inspectTarballStream(Readable.from([body]),limits,undefined,{path:'package/payload',offset:12,length:10}),/outside/);
  await assert.rejects(inspectTarballStream(Readable.from([body.subarray(0,body.length-8)]),limits,undefined,{path:'package/payload',offset:0,length:1}));

  await assert.rejects(inspectTarballStream(Readable.from([body]),{...limits,expandedBytes:512}),/expanded byte budget/);
  await assert.rejects(inspectTarballStream(Readable.from([body]),{...limits,manifestBytes:2}),/manifest byte budget/);
  await assert.rejects(inspectTarballStream(Readable.from([body.subarray(0,body.length-8)]),limits));
  await assert.rejects(inspectTarballStream(Readable.from((async function*(){yield body.subarray(0,3);throw Error('actual input failure');})()),limits),/actual input failure/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
