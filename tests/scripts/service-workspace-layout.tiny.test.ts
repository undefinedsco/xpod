import {test,expect} from 'bun:test';
import * as M from '../../scripts/lib/independent-admission/candidate-service-workspace-inputs';
import * as L from '../../scripts/lib/independent-admission/legal-registry-originals';

const budget=()=>({reserveBytes(){},remainingMs:()=>60000,chargeReadBytes(){},check(){}});
const base={source:{},originals:[],directory:'/tmp/none',budget:budget()};
const rejects=async(fn:()=>Promise<unknown>,pattern?:RegExp)=>{
 try{await fn();}catch(error){if(pattern)expect(pattern.test((error as Error).message)).toBe(true);return;}
 throw Error('expected rejection');
};

test('exports the one registry layout assembler and its same-capability getter',()=>{
 expect(typeof M.stageCandidateServiceBuildRegistryLayout).toBe('function');
 expect(typeof M.candidateServiceBuildRegistryLayoutStageView).toBe('function');
 // Only the new function's budget is extended; existing signatures unchanged.
 expect(M.stageCandidateServiceBuildDependency.length).toBe(1);
 expect(M.candidateServiceBuildRegistryLayoutStageView({}, {source:{},originals:[]})).toBeUndefined();
 expect(M.candidateServiceBuildRegistryLayoutStageView({}, {source:{},originals:[]})).toBeUndefined();
 expect(typeof L.registryLegalLockLayoutEntries).toBe('function');
});

test('non-array or empty originals and absent budget accounting reject before any staging',async()=>{
 await rejects(()=>M.stageCandidateServiceBuildRegistryLayout({...base,originals:undefined as never}),/genuine registry originals/);
 await rejects(()=>M.stageCandidateServiceBuildRegistryLayout({...base}),/genuine registry originals/);
 await rejects(()=>M.stageCandidateServiceBuildRegistryLayout({...base,originals:[{}],budget:{reserveBytes(){},check(){}} as never}),/read accounting/);
 await rejects(()=>M.stageCandidateServiceBuildRegistryLayout({...base,originals:[{}],budget:{reserveBytes(){},check(){},remainingMs:()=>60000} as never}),/read accounting/);
});

test('forged or copied original values have no genuine registry view',async()=>{
 for(const forged of [{}, Object.freeze({}), {sourceSha:'x'}, Buffer.from('x'), Object.create(null)]){
  await rejects(()=>M.stageCandidateServiceBuildRegistryLayout({...base,originals:[forged] as never}),/genuine source|registry layout|same private source|genuine immutable Git/);
 }
});

test('configuration object cannot introduce a second registry or stage view',()=>{
 const view=M.candidateServiceBuildRegistryLayoutStageView(Object.freeze({}),{source:{},originals:[]});
 expect(view).toBeUndefined();
 // The exported surface exposes no registry/cap issuer, only the stage/getter pair.
 const names=Object.keys(M).sort();
 expect(names).toContain('stageCandidateServiceBuildRegistryLayout');
 expect(names).toContain('candidateServiceBuildRegistryLayoutStageView');
 expect(names.filter(name=>/issuer|registryLegalOriginal$|createOriginal/u.test(name))).toEqual([]);
});
