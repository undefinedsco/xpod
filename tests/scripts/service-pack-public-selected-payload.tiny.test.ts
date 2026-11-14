import {test,expect} from 'bun:test';
import fs from 'node:fs';import path from 'node:path';import {Readable} from 'node:stream';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';
import {createTinyServicePackProtocol} from './service-pack-protocol.fixture';
import {verifyServicePackPublicSelectedMembers} from '../../scripts/lib/independent-admission/service-pack-public-selected-payload';
const {readCopyLedger,createCopyLedger}=createRequire(import.meta.url)('../../scripts/service-pack-copy-ledger.cjs');
const {inspectTarballStream}=createRequire(import.meta.url)('../../scripts/workspace-package-payload.cjs');
const sha=(raw:Buffer)=>createHash('sha256').update(raw).digest('hex');
test('actual selected source archive replays command/list/source and exact members; resealed semantic mutations reject',async()=>{
 const parent=path.resolve('.test-data/service-pack-public-selected-replay');fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(path.join(parent,'actual-'));
 try{const actual=createTinyServicePackProtocol(path.join(root,'producer'),Buffer.from('{"name":"@undefineds.co/xpod","version":"1.2.3-rc.1.1"}'),'a'.repeat(40));const body=actual.collection.records.find((row:any)=>row.kind==='actual-pack-body'&&row.role==='public-selected-input-source-tar');expect(body).toBeDefined();const raw=actual.bodies.find((row:any)=>row.reference.path===body.reference.path)!.bytes;const parsed=await inspectTarballStream(Readable.from([raw]),{expandedBytes:1024*1024,members:100,manifestBytes:128*1024,memberDigests:true,memberMetadataBytes:4096});
 const run=(collection=actual.collection,members=parsed.memberDigests,objects=actual.objects)=>verifyServicePackPublicSelectedMembers({collection,body:collection.records.find((row:any)=>row.kind==='actual-pack-body'&&row.role==='public-selected-input-source-tar'),members,used:new Set(),readObject:ref=>Buffer.from(objects.get(ref.path)!),check(){}});
 expect(run().publicSelectedInputSnapshotPayloadVerified).toBe(true);expect(actual.collection.details.budget.reservedOriginalBytes).toBe(0);
 const edit=(change:(collection:any)=>void)=>{const value=structuredClone(actual.collection);change(value);return()=>run(value);};
 expect(edit(c=>{c.records.find((r:any)=>r.role==='actual-public-pack-selected-input-window').sourceBody.sha256='f'.repeat(64);})).toThrow();
 expect(edit(c=>{c.records.find((r:any)=>r.kind==='actual-pack-body'&&r.role==='public-selected-input-source-tar').list.postIdentity[1]='999';})).toThrow('held');
 expect(edit(c=>{c.records.find((r:any)=>r.role==='actual-public-pack-selected-input-window').packCommandRecords.first++;})).toThrow('command');
 expect(edit(c=>{c.records.find((r:any)=>r.kind==='actual-pack-body'&&r.role==='public-selected-input-source-tar').reservation.settledBytes++;})).toThrow('reservation');
 expect(edit(c=>{c.records.find((r:any)=>r.kind==='actual-pack-body'&&r.role==='public-selected-input-source-tar').cleanup[0].errno='EACCES';})).toThrow('absence');
 const missing=parsed.memberDigests.slice(1);expect(()=>run(actual.collection,missing)).toThrow('count');const wrong=structuredClone(parsed.memberDigests);wrong[0].sha256='f'.repeat(64);expect(()=>run(actual.collection,wrong)).toThrow('member');
 const collection=structuredClone(actual.collection),objects=new Map(actual.objects);const window=collection.records.find((r:any)=>r.role==='actual-public-pack-selected-input-window'),old=window.checkpoint,changed=readCopyLedger(objects.get(old.path)!,()=>{});changed[0].bytes++;const ledger=createCopyLedger({roots:[window.sourceRoot],check(){}});for(const row of changed)ledger.add(row);const encoded=ledger.seal(),ref={path:'objects/'+sha(encoded)+'.original',bytes:encoded.length,sha256:sha(encoded)};objects.delete(old.path);objects.set(ref.path,encoded);window.checkpoint=ref;collection.records.find((r:any)=>r.kind==='actual-pack-body'&&r.role==='public-selected-input-source-tar').checkpoint=ref;expect(()=>run(collection,parsed.memberDigests,objects)).toThrow('changed');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
