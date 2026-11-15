import {test,expect} from 'bun:test';
import {createRequire} from 'node:module';
import {inspectCandidateRootMutation,observeCandidateServiceRootMutation} from '../../scripts/lib/independent-admission/candidate-service-root-mutation';
const require=createRequire(import.meta.url),{applyPlatformOptionalDependencies}=require('../../scripts/platform-binaries.cjs');
const raw=(value:unknown)=>Buffer.from(JSON.stringify(value));
const before={name:'@undefineds.co/xpod',version:'1.2.3',scripts:{build:'bun run build:ts'},optionalDependencies:{unrelated:'2.0.0','@undefineds.co/xpod-stale':'0.0.0'}};
const sourceSha='1'.repeat(40),run={id:7,run_attempt:2,run_number:19,head_sha:sourceSha,head_branch:'staging',event:'push'};
function fixture(){return {before:raw(before),immutable:raw(before),after:raw(applyPlatformOptionalDependencies({...before,version:'1.2.3-rc.19.2'},'1.2.3-rc.19.2')),run:{...run},sourceSha,runId:7,runAttempt:2};}
test('actual root mutation uses existing candidate and platform dependency SSOT',()=>{const facts=inspectCandidateRootMutation(fixture());expect(facts.candidateVersion).toBe('1.2.3-rc.19.2');expect(facts.rootCandidateMutationVerified).toBe(true);});
test('wrong run, changed input, omitted platform sync and unrelated mutation fail closed',()=>{
 for(const delta of [{id:8},{run_attempt:1},{run_number:0},{head_sha:'2'.repeat(40)},{head_branch:'main'},{event:'pull_request'}])expect(()=>inspectCandidateRootMutation({...fixture(),run:{...run,...delta}})).toThrow();
 expect(()=>inspectCandidateRootMutation({...fixture(),immutable:raw({...before,version:'1.2.4'})})).toThrow();
 expect(()=>inspectCandidateRootMutation({...fixture(),after:raw({...before,version:'1.2.3-rc.19.2'})})).toThrow();
 const input=fixture(),after=JSON.parse(input.after.toString());after.scripts.build='echo fake';expect(()=>inspectCandidateRootMutation({...input,after:raw(after)})).toThrow();
 expect(()=>inspectCandidateRootMutation({...fixture(),after:Buffer.alloc(128*1024+1)})).toThrow();
});
test('producer JSON cannot obtain the existing native/source private observation',()=>{expect(()=>observeCandidateServiceRootMutation({originals:{...fixture()},source:{sourceSha}})).toThrow('issued');});
