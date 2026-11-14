import {test,expect} from 'bun:test';import fs from 'node:fs';import path from 'node:path';
import {createTinyServicePackProtocol} from './service-pack-protocol.fixture';
import {inspectServicePackCopiedPayloads} from '../../scripts/lib/independent-admission/service-pack-copied-payload';
test('sole actual copied source tar closes all member bytes/modes and rejects resealed altered copy claims',async()=>{
 const parent=path.resolve('.test-data/service-pack-copied-payload');fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(path.join(parent,'actual-'));
 try{const actual=createTinyServicePackProtocol(path.join(root,'producer'),Buffer.from(JSON.stringify({name:'@undefineds.co/xpod',version:'1.2.3-rc.1.1'})),'a'.repeat(40));const input={collection:actual.collection,readBody:async(ref:any)=>Buffer.from(actual.bodies.find((body:any)=>body.reference.path===ref.path)!.bytes),remaining:{expandedBytes:32*1024*1024,members:50000},readObject:(ref:any)=>Buffer.from(actual.objects.get(ref.path)!),check(){}};
 const proof=await inspectServicePackCopiedPayloads(input);expect(proof.selectedInputSnapshotPayloadVerified).toBe(true);expect(proof.verified).toBeGreaterThan(0);expect(proof.officialRegistrySourceVerified).toBe(false);expect(proof.immutableGitSourceVerified).toBe(false);
 const change=(mode:string)=>{const collection=structuredClone(actual.collection);if(mode==='interval')collection.records.find((row:any)=>row.kind==='actual-pack-body'&&row.role==='selected-input-source-tar').copiedRecords.last--;else{const row=collection.records.find((row:any)=>row.role==='actual-selected-input-copy-ledger');if(mode==='missing')row.reference.sha256='f'.repeat(64);else row.destinationRoot='/escape';}return collection;};
 for(const mode of ['interval','missing'])await expect(inspectServicePackCopiedPayloads({...input,collection:change(mode),remaining:{expandedBytes:32*1024*1024,members:50000}})).rejects.toThrow();

 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
