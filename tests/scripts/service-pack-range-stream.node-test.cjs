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
  await assert.rejects(inspectTarballStream(Readable.from([body]),{...limits,expandedBytes:512}),/expanded byte budget/);
  await assert.rejects(inspectTarballStream(Readable.from([body]),{...limits,manifestBytes:2}),/manifest byte budget/);
  await assert.rejects(inspectTarballStream(Readable.from([body.subarray(0,body.length-8)]),limits));
  await assert.rejects(inspectTarballStream(Readable.from((async function*(){yield body.subarray(0,3);throw Error('actual input failure');})()),limits),/actual input failure/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
