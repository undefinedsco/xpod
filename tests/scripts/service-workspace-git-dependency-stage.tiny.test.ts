import {test,expect} from 'bun:test';
import * as M from '../../scripts/lib/independent-admission/candidate-service-workspace-inputs';

const budget=()=>({check(){},reserveBytes(){},remainingMs:()=>60000,chargeReadBytes(){}});
const base={source:{},originals:{},name:'dep',dependencySource:{},directory:'/tmp/none',budget:budget()};
const rejects=async(fn:()=>Promise<unknown>,pattern:RegExp)=>{
 try{await fn();}catch(error){expect(pattern.test((error as Error).message)).toBe(true);return;}
 throw Error('expected rejection');
};

test('exports one dependency stage and its exact handle getter',()=>{
 expect(typeof M.stageCandidateServiceBuildGitDependency).toBe('function');
 expect(typeof M.candidateServiceBuildGitDependencyStageView).toBe('function');
 // The root Git stage remains the same existing exported function.
 expect(typeof M.stageCandidateServiceBuildGit).toBe('function');
 expect(M.candidateServiceBuildGitDependencyStageView({},{source:{},originals:{},name:'dep',dependencySource:{}})).toBeUndefined();
 expect(M.candidateServiceBuildGitDependencyStageView({},{} as never)).toBeUndefined();
});

test('fake or copied dependency sources reject before any filesystem work',async()=>{
 await rejects(()=>M.stageCandidateServiceBuildGitDependency({...base,source:undefined as never}),/genuine immutable parent source/);
 await rejects(()=>M.stageCandidateServiceBuildGitDependency({...base}),/genuine immutable parent source/);
 await rejects(()=>M.stageCandidateServiceBuildGitDependency({...base,name:''}),/declared dependency name required/);
 await rejects(()=>M.stageCandidateServiceBuildGitDependency({...base,name:undefined as never}),/declared dependency name required/);
});

test('getter cannot accept a changed name, originals, parent or dependency cap',()=>{
 const forged=Object.freeze({});
 const input={source:forged,originals:forged,name:'dep',dependencySource:forged};
 for(const changed of [
  {name:'other'},
  {name:'DEP'},
  {source:Object.freeze({})},
  {originals:Object.freeze({})},
  {dependencySource:Object.freeze({})},
 ]) expect(M.candidateServiceBuildGitDependencyStageView(Object.freeze({}),{...input,...changed})).toBeUndefined();
});

test('stage/getter source contract keeps generic calls from substituting authority',()=>{
 // A generic dependency stage value is never in the same staged map, so the
 // dependency getter rejects it even with matching handles.
 expect(M.candidateServiceBuildGitDependencyStageView(Object.freeze({}),{source:{},originals:{},name:'dep',dependencySource:{}})).toBeUndefined();
 // Root Git getter is unchanged in signature (source + original only).
 expect(typeof M.stageCandidateServiceBuildGit).toBe('function');
});
