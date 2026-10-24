import {test,expect} from 'bun:test';
import {observeCandidateServiceRetainedBuildDependencyOriginal} from '../../scripts/lib/independent-admission/legal-registry-originals';
const sha='a'.repeat(40);
/** Structurally plausible stand-ins: they are NOT capabilities issued by the
 * private collectors, so the new export must reject them before reserving
 * budget or opening a socket. */
const fakeOriginals:any={origin:{kind:'github-workflow-artifact'},originFacts:{sourceSha:sha},members:[{path:'service-image-materials.json',bytes:2,sha256:'0'.repeat(64)}],readOriginalRange:()=>Buffer.alloc(0)};
const fakeSource:any={sourceSha:sha,trackedPaths:['bun.lock'],readTracked:()=>Buffer.from('{}'),readTrackedGitObject:()=>Buffer.alloc(0)};
function budgetSpy(){const calls:any[]=[];const budget:any={check:()=>calls.push('check'),remainingMs:()=>{calls.push('remainingMs');return 1000;},reserveBytes:(n:number)=>calls.push(['reserveBytes',n]),reserveOriginalMaximum:(n:number)=>{calls.push(['reserveOriginalMaximum',n]);return {};},settleOriginalReservation:()=>calls.push('settle')};return{budget,calls};}
async function rejectWithoutEffects(input:any){const {budget,calls}=budgetSpy();const previous=globalThis.fetch;let fetches=0;globalThis.fetch=(async()=>{fetches++;throw Error('must not fetch');}) as typeof fetch;try{await expect(observeCandidateServiceRetainedBuildDependencyOriginal({...input,budget})).rejects.toThrow('same private service/source originals required');expect(fetches).toBe(0);expect(calls).toEqual([]);}finally{globalThis.fetch=previous;}}
test('fake originals/source are rejected before budget or network',async()=>{await rejectWithoutEffects({originals:fakeOriginals,source:fakeSource,name:'left-pad',version:'1.3.0'});});
test('copied JSON stand-ins are rejected before budget or network',async()=>{await rejectWithoutEffects({originals:JSON.parse(JSON.stringify(fakeOriginals)),source:JSON.parse(JSON.stringify(fakeSource)),name:'left-pad',version:'1.3.0'});});
test('mixed fake originals with copied source are rejected before budget or network',async()=>{await rejectWithoutEffects({originals:fakeOriginals,source:{...fakeSource},name:'left-pad',version:'1.3.0'});});
test('mixed copied originals with fake source are rejected before budget or network',async()=>{await rejectWithoutEffects({originals:{...fakeOriginals},source:fakeSource,name:'left-pad',version:'1.3.0'});});
// Genuine private-fixture coverage (canonical URL, immutable Bun lock SRI,
// complete archive, retained custody/current source, executable closure and
// parent reservation settlement) is supplied separately by the coordinator.
// These tests prove only the pre-budget/pre-network rejection gate.

test('legacy online parser retains its original 8 MiB archive boundary',async()=>{
 const {measureRegistryArchiveExpansion}=await import('../../scripts/lib/independent-admission/legal-registry-originals');
 await expect(measureRegistryArchiveExpansion(Buffer.alloc(8*1024**2+1),32*1024**2,new AbortController().signal)).rejects.toThrow('bounded expansion measurement required');
});

test('typed build stream declaration cannot permit another path or mismatched closed reference',async()=>{
 const {inspectCandidateServiceOriginalUniverse}=await import('../../scripts/lib/independent-admission/qlever-sdk-service-relationship');
 const integrity='sha512-'+Buffer.alloc(64,1).toString('base64'),prefix='build-inputs/registry/'+Buffer.alloc(64,1).toString('hex')+'/',archive={path:prefix+'archive.tgz',bytes:4*1024**2+1,sha256:'0'.repeat(64)},metadata={path:prefix+'metadata.json',bytes:1,sha256:'0'.repeat(64)},transport={path:prefix+'transport.json',bytes:1,sha256:'0'.repeat(64)};
 const originals=[archive,metadata,transport],view:any={members:[{path:'service-image-materials.json',bytes:1,sha256:'0'.repeat(64)},...originals],readOriginalRange(){throw Error('must reject before original reads');}};
 const row={name:'node-pty',version:'1.1.0',integrity,archive,metadata,transport},master={originals,buildInputObservation:{schemaVersion:1,kind:'retained-official-registry-build-inputs',packages:[row]}};
 expect(()=>inspectCandidateServiceOriginalUniverse(view,{originals})).toThrow('large service original requires exact typed pack stream');
 expect(()=>inspectCandidateServiceOriginalUniverse(view,{...master,buildInputObservation:{...master.buildInputObservation,packages:[{...row,archive:{...archive,path:'other/archive.tgz'}}]}})).toThrow('canonical typed build original paths');
 expect(()=>inspectCandidateServiceOriginalUniverse(view,{...master,buildInputObservation:{...master.buildInputObservation,packages:[{...row,archive:{...archive,bytes:archive.bytes-1}}]}})).toThrow('exact typed service stream reference');
});
