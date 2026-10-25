import {test,expect} from 'bun:test';
import {observeCandidateServiceBuildDependencyOriginal} from '../../scripts/lib/independent-admission/legal-registry-originals';
const sha='a'.repeat(40);
/** Structurally plausible stand-ins: they are NOT capabilities issued by the
 * private collectors, so the new export must reject them before reserving
 * budget or opening a socket. */
const fakeOriginals:any={origin:{kind:'github-workflow-artifact'},originFacts:{sourceSha:sha},members:[{path:'service-image-materials.json',bytes:2,sha256:'0'.repeat(64)}],readOriginalRange:()=>Buffer.alloc(0)};
const fakeSource:any={sourceSha:sha,trackedPaths:['bun.lock'],readTracked:()=>Buffer.from('{}'),readTrackedGitObject:()=>Buffer.alloc(0)};
function budgetSpy(){const calls:any[]=[];const budget:any={check:()=>calls.push('check'),remainingMs:()=>{calls.push('remainingMs');return 1000;},reserveBytes:(n:number)=>calls.push(['reserveBytes',n]),reserveOriginalMaximum:(n:number)=>{calls.push(['reserveOriginalMaximum',n]);return {};},settleOriginalReservation:()=>calls.push('settle')};return{budget,calls};}
async function rejectWithoutEffects(input:any){const {budget,calls}=budgetSpy();const previous=globalThis.fetch;let fetches=0;globalThis.fetch=(async()=>{fetches++;throw Error('must not fetch');}) as typeof fetch;try{await expect(observeCandidateServiceBuildDependencyOriginal({...input,budget})).rejects.toThrow('same private service/source originals required');expect(fetches).toBe(0);expect(calls).toEqual([]);}finally{globalThis.fetch=previous;}}
test('fake originals/source are rejected before budget or network',async()=>{await rejectWithoutEffects({originals:fakeOriginals,source:fakeSource,name:'left-pad',version:'1.3.0'});});
test('copied JSON stand-ins are rejected before budget or network',async()=>{await rejectWithoutEffects({originals:JSON.parse(JSON.stringify(fakeOriginals)),source:JSON.parse(JSON.stringify(fakeSource)),name:'left-pad',version:'1.3.0'});});
test('mixed fake originals with copied source are rejected before budget or network',async()=>{await rejectWithoutEffects({originals:fakeOriginals,source:{...fakeSource},name:'left-pad',version:'1.3.0'});});
test('mixed copied originals with fake source are rejected before budget or network',async()=>{await rejectWithoutEffects({originals:{...fakeOriginals},source:fakeSource,name:'left-pad',version:'1.3.0'});});
// Genuine private-fixture coverage (canonical URL, immutable Bun lock SRI,
// complete archive, retained custody/current source, executable closure and
// parent reservation settlement) is supplied separately by the coordinator.
// These tests prove only the pre-budget/pre-network rejection gate.
