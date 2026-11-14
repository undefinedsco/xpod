import {test,expect} from 'bun:test';
import * as M from '../../scripts/lib/independent-admission/candidate-service-workspace-materialize';
import * as S from '../../scripts/lib/independent-admission/candidate-service-workspace-inputs';
import * as L from '../../scripts/lib/independent-admission/legal-registry-originals';

const budget=()=>({check(){},reserveBytes(){},remainingMs:()=>60000,chargeReadBytes(){}});
const base={source:{},gitStage:{},registryStage:{},registryOriginals:[{}],bunStage:{},bunOriginal:{},directory:'/tmp/none',budget:budget()};
const rejects=async(fn:()=>Promise<unknown>,pattern:RegExp)=>{
 try{await fn();}catch(error){expect(pattern.test((error as Error).message)).toBe(true);return;}
 throw Error('expected rejection');
};

test('single exported materializer and private same-handle getter',()=>{
 expect(typeof M.materializeCandidateServiceBuildWorkspace).toBe('function');
 expect(typeof M.candidateServiceBuildMaterializedWorkspaceView).toBe('function');
 expect(M.candidateServiceBuildMaterializedWorkspaceView({}, {source:{},gitStage:{},registryStage:{},registryOriginals:[],bunStage:{},bunOriginal:{}})).toBeUndefined();
 expect(Object.keys(M).filter(name=>/issuer|qualif|complete/u.test(name))).toEqual([]);
 expect(typeof L.registryLegalLockWorkspaceEntries).toBe('function');
 // Reuses the existing staged getters rather than a second registry.
 expect(typeof S.candidateServiceBuildDependencyStageView).toBe('function');
 expect(typeof S.candidateServiceBuildRegistryLayoutStageView).toBe('function');
 expect(typeof L.registryLegalOriginalView).toBe('function');
});

test('budget without read accounting rejects before any stage or filesystem work',async()=>{
 await rejects(()=>M.materializeCandidateServiceBuildWorkspace({...base,budget:{check(){},reserveBytes(){}} as never}),/parent budget with read accounting/);
 await rejects(()=>M.materializeCandidateServiceBuildWorkspace({...base,budget:{check(){},reserveBytes(){},remainingMs:()=>1} as never}),/parent budget with read accounting/);
});

test('absent source or forged stages reject and issue no capability',async()=>{
 await rejects(()=>M.materializeCandidateServiceBuildWorkspace({...base,source:undefined as never}),/genuine immutable Git source/);
 await rejects(()=>M.materializeCandidateServiceBuildWorkspace({...base}),/genuine immutable Git source/);
 // A plain object is not a genuine source context, so no staged getter can pass.
 await rejects(()=>M.materializeCandidateServiceBuildWorkspace({...base}),/genuine immutable Git source/);
});

test('getter binds exact handles including ordered registry originals',()=>{
 const forged=Object.freeze({});
 const input={source:forged,gitStage:{},registryStage:{},registryOriginals:[{}],bunStage:{},bunOriginal:{}};
 expect(M.candidateServiceBuildMaterializedWorkspaceView(forged,input)).toBeUndefined();
 expect(M.candidateServiceBuildMaterializedWorkspaceView(Object.freeze({}),input)).toBeUndefined();
 expect(M.candidateServiceBuildMaterializedWorkspaceView(Object.freeze({}),{...input,registryOriginals:[]})).toBeUndefined();
 expect(M.candidateServiceBuildMaterializedWorkspaceView(Object.freeze({}),{...input,registryOriginals:[{},{}]})).toBeUndefined();
});

test('lock workspace entries exclude the root and keep declared name/path only',()=>{
 const lock=Buffer.from(JSON.stringify({lockfileVersion:1,workspaces:{'':{name:'root'},'packages/a':{name:'@scope/a'},'ui':{name:'ui'}},packages:{}}));
 const rows=L.registryLegalLockWorkspaceEntries(lock);
 expect(rows).toEqual([
  {logicalPath:'packages/a',name:'@scope/a'},
  {logicalPath:'ui',name:'ui'},
 ]);
 expect(rows.every(row=>Object.isFrozen(row))).toBe(true);
 expect(Object.isFrozen(rows)).toBe(true);
 expect(rows.some(row=>row.logicalPath==='')).toBe(false);
 expect(()=>L.registryLegalLockWorkspaceEntries(Buffer.from('{}'))).toThrow();
});


test('forged Git dependency records reject before any filesystem work',async()=>{
 const forged=Object.freeze({});
 for(const dependency of [
  {stage:forged,dependencySource:forged,originals:forged,name:'dep'},
  {stage:forged,dependencySource:forged,originals:forged,name:''},
  {stage:forged,dependencySource:forged,originals:forged,name:'../escape'},
  null,
 ] as never[]) await rejects(()=>M.materializeCandidateServiceBuildWorkspace({...base,gitDependencies:[dependency] as never}),/declared dependency name|Git dependency record|genuine same-parent authenticated Git dependency|genuine immutable Git/);
 // Duplicate declared names are rejected on the ordered record set itself.
 const one={stage:forged,dependencySource:forged,originals:forged,name:'dep'};
 await rejects(()=>M.materializeCandidateServiceBuildWorkspace({...base,gitDependencies:[one,one] as never}),/genuine same-parent authenticated Git dependency|unique Git dependency name|genuine immutable Git/);
});

test('materialized getter rejects changed dependency handle order/identity',()=>{
 const stage={},dependencySource={},originals={};
 const input={source:{},gitStage:{},registryStage:{},registryOriginals:[{}],bunStage:{},bunOriginal:{},gitDependencies:[{stage,dependencySource,originals,name:'dep'}]};
 for(const changed of [
  {gitDependencies:[]},
  {gitDependencies:[{stage:{},dependencySource,originals,name:'dep'}]},
  {gitDependencies:[{stage,dependencySource:{},originals,name:'dep'}]},
  {gitDependencies:[{stage,dependencySource,originals:{},name:'dep'}]},
  {gitDependencies:[{stage,dependencySource,originals,name:'other'}]},
 ]) expect(M.candidateServiceBuildMaterializedWorkspaceView(Object.freeze({}),{...input,...changed})).toBeUndefined();
});


test('post-build receipt is a mechanical custody object, not authority',()=>{
 // The method is only reachable on a genuine issued view; a forged handle never
 // exposes it, so no fake-cap receipt can be minted by callers.
 const forged=Object.freeze({});
 const viewInput={source:{},gitStage:{},registryStage:{},registryOriginals:[{}],bunStage:{},bunOriginal:{}};
 expect(M.candidateServiceBuildMaterializedWorkspaceView(forged,viewInput)).toBeUndefined();
 expect((forged as {assertPostBuild?:unknown}).assertPostBuild).toBeUndefined();
 // No completion/source-capability symbol is exported by this module.
 expect(Object.keys(M).filter(name=>/complete|qualif|issuer|sourceVerified/u.test(name))).toEqual([]);
});
