import os from 'node:os';import {createRequire} from 'node:module';
import {replayServicePackManifest} from '../../scripts/lib/independent-admission/service-pack-manifest-replay';
const {inspectTarballBuffer}=createRequire(import.meta.url)('../../scripts/workspace-package-payload.cjs');
import {test,expect} from 'bun:test';import fs from 'node:fs';import path from 'node:path';
import {createTinyServicePackProtocol} from './service-pack-protocol.fixture';
import {inspectServicePackInputCustody} from '../../scripts/lib/independent-admission/service-pack-input-custody';
test('actual host Node full search originals replay and omitted/extra/changed first-hit candidates reject without remapping ancestors',()=>{
 const parent=path.resolve('.test-data/service-pack-resolution-search');fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(path.join(parent,'actual-'));
 try{const afterRoot=Buffer.from('{"name":"@undefineds.co/xpod","version":"1.2.3-rc.1.1"}'),full=createTinyServicePackProtocol(path.join(root,'producer'),afterRoot,'a'.repeat(40)),actual=full.unplaced;
 const run=(collection=actual.collection)=>inspectServicePackInputCustody({collection,repoRoot:actual.repoRoot,afterRoot,readObject:ref=>Buffer.from(actual.objects.get(ref.path)!),readWorkspaceOriginal(){throw Error('no workspace input');},check(){}});
 const parseBody=(role:string)=>{const row=actual.collection.records.find((r:any)=>r.kind==='actual-pack-body'&&r.role===role);const original=full.bodies.find((r:any)=>r.reference.path===row.reference.path)!.bytes;return inspectTarballBuffer(original,{expandedBytes:4*1024**2,members:100,gnuLongNames:true}).entries.find((r:any)=>r.path==='package/package.json').content as Buffer;};
 const publicManifests=new Map<string,Buffer>();for(const row of actual.collection.records.filter((r:any)=>r.kind==='actual-pack-body'&&r.role==='public-package-tar'))publicManifests.set(row.name,parseBody('public-package-tar'));
 const replay=(collection=actual.collection)=>replayServicePackManifest({collection,repoRoot:actual.repoRoot,temporaryRoot:os.tmpdir(),afterRoot,seedManifest:parseBody('seed-npm-pack'),finalManifest:parseBody('final-service-pack'),publicManifests,readObject:ref=>Buffer.from(actual.objects.get(ref.path)!),assertWorkspaceSource:(_relative,raw)=>{if(!raw.equals(afterRoot))throw Error('source root differs');}});
 const replayed=replay();expect(replayed.installedDependencySearchReplayed).toBe(true);
 expect(replayed.selectedInputInstances.length).toBeGreaterThan(0);
 expect(new Set(replayed.selectedInputInstances.map(row=>row.destinationRoot)).size).toBe(replayed.selectedInputInstances.length);
 expect(replayed.selectedInputInstances.every(row=>row.sourceRoot.startsWith(actual.repoRoot)&&row.inputKind==='installed')).toBe(true);
 expect(Object.isFrozen(replayed.selectedInputInstances)).toBe(true);
 expect(replayed.packInputResolutionVerified).toBe(false);
 expect(run().dependencySearchCustodyVerified).toBe(true);const edit=(change:(collection:any)=>void)=>{const c=structuredClone(actual.collection);change(c);return()=>run(c);};
 expect(edit(c=>{c.records.find((r:any)=>r.role==='actual-node-resolution').searchRoots.shift();})).toThrow('search vector');const altered=structuredClone(actual.collection);altered.records.find((r:any)=>r.role==='actual-node-resolution').searchRoots.shift();expect(()=>replay(altered)).toThrow('search vector');
 expect(edit(c=>{const r=c.records.find((r:any)=>r.role==='actual-node-resolution');r.probes.shift();const at=c.records.indexOf(r);c.records[at+1].observations.shift();})).toThrow('prefix');
 expect(edit(c=>{const r=c.records.find((r:any)=>r.role==='actual-node-resolution');r.searchRoots.push('/unclaimed/node_modules');})).toThrow('search vector');
 expect(edit(c=>{const r=c.records.find((r:any)=>r.role==='actual-node-resolution');r.probes[0].path='/other/node_modules/'+r.name;})).toThrow('prefix');
 expect(edit(c=>{const r=c.records.find((r:any)=>r.role==='actual-node-resolution');r.probes.push({...r.probes[r.probes.length-1]});c.records[c.records.indexOf(r)+1].observations.push({...c.records[c.records.indexOf(r)+1].observations[c.records[c.records.indexOf(r)+1].observations.length-1]});})).toThrow();
 const legacy=structuredClone(actual.collection);delete legacy.details.resolutionSearchModel;for(const r of legacy.records)if(r.role==='actual-node-resolution'){delete r.searchRoots;delete r.globalPaths;}
 // A retained Linux worker declaration requires its matching search model.
 if(legacy.details.nodeRuntimeModel==='actual-linux-node-worker-executable-v1')expect(()=>run(legacy)).toThrow('same actual runtime search model');
 delete legacy.details.nodeRuntimeModel;
 legacy.records=legacy.records.filter((row:any)=>!['actual-node-runtime-before','actual-node-runtime-after'].includes(row.role));
 expect(run(legacy).dependencySearchCustodyVerified).toBe(false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
