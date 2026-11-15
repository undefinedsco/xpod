/** Actual tiny producer bodies; upstream placement/parent receipts are simulated.
 * This verifies record replay and stream binding, not a native/source capability. */
import {test,expect} from 'bun:test';
import fs from 'node:fs';import path from 'node:path';import {Readable} from 'node:stream';import {createRequire} from 'node:module';
import {createTinyServicePackProtocol} from './service-pack-protocol.fixture';
import {replayServicePackManifest} from '../../scripts/lib/independent-admission/service-pack-manifest-replay';
const {inspectTarballStream}=createRequire(import.meta.url)('../../scripts/workspace-package-payload.cjs');
test('same-call actual seed/public/final bodies bind sole replay; changed body/object/ordering fail',async()=>{
 const parent=path.resolve('.test-data/service-pack-actual-bodies');fs.mkdirSync(parent,{recursive:true});const directory=fs.mkdtempSync(path.join(parent,'run-'));
 try{
  const afterRoot=Buffer.from(JSON.stringify({name:'@undefineds.co/xpod',version:'1.2.3-rc.1.1'})),value=createTinyServicePackProtocol(path.join(directory,'producer'),afterRoot,'a'.repeat(40));
  const manifests=new Map<string,Buffer>();let expanded=0,members=0;
  for(const body of value.bodies){const stream=Readable.from((function*(){for(let offset=0;offset<body.bytes.length;offset+=65536)yield body.bytes.subarray(offset,offset+65536);})());const parsed=await inspectTarballStream(stream,{expandedBytes:512*1024**2-expanded,members:50000-members,manifestBytes:128*1024});expanded+=parsed.expandedBytes;members+=parsed.members;manifests.set(body.reference.path,parsed.manifestOriginal);}
  const records=value.collection.records.filter((row:any)=>row.kind==='actual-pack-body'),seed=records.find((row:any)=>row.role==='seed-npm-pack'),final=records.find((row:any)=>row.role==='final-service-pack'),publicManifests=new Map<string,Buffer>(records.filter((row:any)=>row.role==='public-package-tar').map((row:any)=>[row.name,manifests.get(row.reference.path)!]));
  const input={collection:value.collection,repoRoot:'/app',temporaryRoot:'/tmp',afterRoot,seedManifest:manifests.get(seed.reference.path)!,finalManifest:manifests.get(final.reference.path)!,publicManifests,readObject:(ref:any)=>Buffer.from(value.objects.get(ref.path)!)};
  const proof=replayServicePackManifest(input);expect(proof.finalManifestOriginal.equals(value.finalManifest)).toBe(true);expect(proof.packInputResolutionVerified).toBe(false);expect(proof.pending.length).toBeGreaterThan(0);
  expect(()=>replayServicePackManifest({...input,finalManifest:Buffer.from('{}')})).toThrow();
  expect(()=>replayServicePackManifest({...input,readObject:()=>Buffer.from('{}')})).toThrow();
  const reordered=structuredClone(value.collection);reordered.records.reverse();expect(()=>replayServicePackManifest({...input,collection:reordered})).toThrow();
  expect(value.actual.status).toBe(0);expect(value.actual.simulatedPlacement).toBe(true);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
