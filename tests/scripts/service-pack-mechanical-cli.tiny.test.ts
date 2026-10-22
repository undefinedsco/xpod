/** Mechanical stdlib helper protocol, not a private capability constructor. */
import {test,expect} from 'bun:test';import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {fixture,sha} from './candidate-service-image-output.fixture';import {createTinyServicePackProtocol} from './service-pack-protocol.fixture';import {placeTinyPack} from './service-pack-placement.fixture';
test('actual tiny producer body set/parent mechanical CLI closes refs and rejects rehashed malformed receipt',()=>{
 const parent=path.resolve('.test-data/service-pack-mechanical-cli');fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(path.join(parent,'run-'));
 try{for(const negative of [undefined,'parent-missing-cleanup','parent-wrong-worker']){
  const sourceSha='a'.repeat(40),f=fixture({sourceSha}),protocol=createTinyServicePackProtocol(path.join(root,negative??'positive'),Buffer.from(JSON.stringify({name:'@undefineds.co/xpod',version:'1.2.3-rc.1.1'})),sourceSha),record=placeTinyPack(f,protocol,sourceSha,negative),output=f.master.outputImageObservation;
  const phase=JSON.parse(f.values.get(record.phase.metadata.path)!.toString()),captured=Object.fromEntries(phase.originals.map((ref:any)=>[ref.path,ref])),phaseOriginals=[['pack.receipt.json',record.phase.receipt],['pack.raw.log',record.phase.raw]].map(([name,ref]:any)=>{const body=f.values.get(ref.path)!;return {name,bytes:body.length,sha256:sha(body),encoding:'base64',content:body.toString('base64')};});
  const request={deadlineUnixMs:Date.now()+5000,collection:protocol.collection,parent:phase,captured,phaseOriginals,workerContext:{source:'/checkout',sourceSha,image:output.imageReferenceByDigest,name:output.containerName,nonce:output.ownerNonce,cid:output.containerId},packObservation:record};
  const run=()=>JSON.parse(execFileSync('/usr/bin/python3',['-I','-S','-B',path.resolve('qlever/scripts/sdk-service-pack-bindings.py')],{input:JSON.stringify(request),stdio:['pipe','pipe','pipe']}).toString());
  if(negative)expect(run).toThrow();else{const observed=run();expect(observed.mechanics.parentRawClosureVerified).toBe(true);expect(observed.workerPlans.length).toBe(protocol.bodies.length+2);expect(observed.bodyOriginals).toEqual(protocol.collection.bodyOriginals);}
 }}finally{fs.rmSync(root,{recursive:true,force:true});}
},15000);
