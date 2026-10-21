/** Invoked only by the tiny actual CLI fixture; never a private source issuer. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {replayServicePackManifest} from '../../scripts/lib/independent-admission/service-pack-manifest-replay';
const require=createRequire(import.meta.url),{inspectTarballFile}=require('../../scripts/workspace-package-payload.cjs');
const root=process.argv[2]!;const collection=JSON.parse(fs.readFileSync(path.join(root,'.test-data/service-pack-originals/materials.json'),'utf8'));
const bodies=new Map<string,Buffer>(),publicManifests=new Map<string,Buffer>();
for(const row of collection.records.filter((row:any)=>row.kind==='actual-pack-body')){
 const file=path.join(root,'.test-data',row.reference.path);const inspected=await inspectTarballFile(file,{expandedBytes:32*1024**2,members:10000,manifestBytes:128*1024});
 if(row.role==='public-package-tar')publicManifests.set(row.name,inspected.manifestOriginal);else bodies.set(row.role,inspected.manifestOriginal);
}
const input={collection,repoRoot:root,temporaryRoot:os.tmpdir(),afterRoot:fs.readFileSync(path.join(root,'package.json')),seedManifest:bodies.get('seed-npm-pack')!,finalManifest:bodies.get('final-service-pack')!,publicManifests,readObject:(reference:any)=>fs.readFileSync(path.join(root,'.test-data/service-pack-originals',reference.path))};
const actual=replayServicePackManifest(input);assert.equal(actual.recordedManifestProjectionReplayed,true);assert.equal(actual.packInputResolutionVerified,false);assert.equal(actual.candidateVersion,'1.0.0');assert.ok(actual.recordedResolutionProbes>=2);assert.equal(JSON.parse(actual.finalManifestOriginal.toString()).dependencies['fixture-external'],'1.0.0');assert.equal(JSON.parse(actual.finalManifestOriginal.toString()).optionalDependencies?.['fixture-external'],undefined);assert.deepEqual(actual.finalManifestOriginal,input.finalManifest);
const mutate=(fn:(value:any)=>void)=>{const copy=JSON.parse(JSON.stringify(collection));fn(copy);assert.throws(()=>replayServicePackManifest({...input,collection:copy}));};
mutate(copy=>{copy.records=copy.records.filter((row:any)=>row.role!=='actual-prepack-policy');});
mutate(copy=>{copy.records.find((row:any)=>row.role==='actual-final-selected-inputs').dependencies[0].name='unrelated';});
mutate(copy=>{copy.records.find((row:any)=>row.role==='actual-bundled-root-probe').canonicalPath='/wrong';});
mutate(copy=>{copy.records.push(copy.records.find((row:any)=>row.role==='actual-final-projected-manifest'));});
mutate(copy=>{copy.records.find((row:any)=>row.role==='actual-manifest-exposure').edge.optional=true;});
assert.throws(()=>replayServicePackManifest({...input,finalManifest:Buffer.from('{}')}));
console.log('actual producer record/body projection replay and six derived negatives passed; source/resolve remains pending');
