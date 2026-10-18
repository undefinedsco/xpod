import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {observeProductConsumerGitHubOrigin,githubOriginFacts} from '../../scripts/lib/independent-admission/github-origin';
import {archiveConsumerArtifactName} from '../../scripts/lib/independent-admission/archive-consumer-originals';
import {registryConsumerArtifactName} from '../../scripts/lib/independent-admission/registry-consumer-originals';
import {CI_CONSUMER_SOURCE_GROUPS,CONSUMER_SOURCE_GROUPS,CALLABLE_PUBLICATION_WORKFLOW_SHA,STAGING_CHECKED_PUBLICATION_WORKFLOW_SHA} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {selectGitHubSourceBindingGroup,sourceBindingKey} from '../../scripts/lib/independent-admission/github-source-binding-groups';
const root=path.resolve(import.meta.dir,'../..');
// Current repository originals are source API fixtures, never a real GitHub run.
const integration=process.env.XPOD_ORIGIN_SOURCE_FIXTURE??root;
const overrides=new Set(['.github/workflows/ci.yml','.github/workflows/independent-publication.yml','scripts/lib/independent-admission/github-origin.ts','scripts/lib/independent-admission/consumer-observer-policy.ts','scripts/lib/independent-admission/consumer-execution-current.json','scripts/lib/publication-control-input.cjs']);
let serial=6000;
async function scenario(stage:'prepublish'|'postpublish',change:{event?:string;branch?:string;job?:string;mutate?:string;status?:string;conclusion?:string|null;jobConclusion?:string;artifactTime?:string;legacyWorkflow?:boolean}={}){
 const source=(++serial).toString(16).padStart(40,'0'),digest='b'.repeat(64),product={module:'client' as const,stage};
 const coordinates={...product,sourceSha:source,runId:5,runAttempt:1};
 const tuple={schemaVersion:1 as const,sourceSha:source,runHeadSha:source,runId:5,runAttempt:1,artifactId:8,artifactSha256:digest};
 const job=stage==='prepublish'?'independent-publication / pre-client-portable / archive-consumer-client-portable':'independent-publication / wave-01 / registry-client-portable / registry-consumer-client-portable';
 const previous=globalThis.fetch;
 globalThis.fetch=(async value=>{
  const endpoint=new URL(String(value)).pathname.replace('/repos/undefinedsco/xpod/','');let body:any;
  if(endpoint==='actions/runs/5/attempts/1')body={id:5,run_attempt:1,head_sha:source,repository:{full_name:'undefinedsco/xpod'},head_repository:{full_name:'undefinedsco/xpod'},status:change.status??'in_progress',conclusion:change.conclusion===undefined?null:change.conclusion,event:change.event??'workflow_dispatch',head_branch:change.branch??'staging',workflow_id:7,path:'.github/workflows/ci.yml'};
  else if(endpoint==='actions/workflows/7')body={id:7,path:'.github/workflows/ci.yml'};
  else if(endpoint.startsWith('contents/')){const name=endpoint.slice(9);let data=fs.readFileSync(path.join(overrides.has(name)?root:integration,name));if(change.legacyWorkflow&&name==='.github/workflows/independent-publication.yml'){
    const block=`      - name: Require exact staging ancestry before installing or executing source
        env:
          SOURCE_SHA: \${{ inputs.source_sha }}
        run: |
          set -euo pipefail
          [[ "$SOURCE_SHA" =~ ^[a-f0-9]{40}$ ]]
          test "$(git rev-parse HEAD)" = "$SOURCE_SHA"
          git merge-base --is-ancestor "$SOURCE_SHA" origin/staging
          test -z "$(git status --porcelain --untracked-files=all)"
`;
    const text=data.toString(),offset=text.lastIndexOf(block);if(offset<0)throw Error('Fixed ancestry fixture block missing');data=Buffer.from(text.slice(0,offset)+text.slice(offset+block.length));
   }if(name===change.mutate)data=Buffer.concat([data,Buffer.from('\n# unreviewed mutation\n')]);body={type:'file',path:name,encoding:'base64',content:data.toString('base64')};}
  else if(endpoint==='actions/artifacts/8')body={id:8,expired:false,workflow_run:{id:5,head_sha:source},digest:'sha256:'+digest,size_in_bytes:100,name:stage==='prepublish'?archiveConsumerArtifactName(coordinates):registryConsumerArtifactName(coordinates),created_at:change.artifactTime??'2026-10-17T00:01:00Z'};
  else if(endpoint==='actions/runs/5/attempts/1/jobs')body={total_count:1,jobs:[{id:10,run_id:5,run_attempt:1,head_sha:source,name:change.job??job,status:'completed',conclusion:change.jobConclusion??'success',started_at:'2026-10-17T00:00:00Z',completed_at:'2026-10-17T00:02:00Z',steps:[stage==='prepublish'?'Run fixed archive-installed product consumer':'Run fixed registry-installed product consumer',stage==='prepublish'?'Upload archive consumer originals':'Upload registry consumer originals'].map(name=>({name,status:'completed',conclusion:'success'}))}]};
  else throw Error('Unexpected fixture request '+endpoint);
  return new Response(JSON.stringify(body));
 }) as typeof fetch;
 try{return await observeProductConsumerGitHubOrigin(tuple,product);}finally{globalThis.fetch=previous;}
}
test('registered caller observes only exact closed pre/post consumer jobs',async()=>{
 for(const stage of ['prepublish','postpublish'] as const){expect(githubOriginFacts(await scenario(stage))?.workflowPath).toBe('.github/workflows/ci.yml');
  for(const change of [{event:'push'},{event:'pull_request'},{branch:'main'},{job:'prefix / independent-publication / pre-client-portable / archive-consumer-client-portable'},{job:'pre-client-portable / archive-consumer-client-portable'},{jobConclusion:'failure'},{artifactTime:'2026-10-17T00:03:00Z'},{status:'completed',conclusion:'failure'}])await expect(scenario(stage,change)).rejects.toThrow();
 }
});
test('caller/reusable/child/helper originals are exact, no mixed whole group',async()=>{
 for(const mutate of ['.github/workflows/ci.yml','.github/workflows/independent-publication.yml','.github/workflows/independent-archive-consumer.yml','scripts/lib/publication-control-input.cjs'])await expect(scenario('prepublish',{mutate})).rejects.toThrow();
 const next=CI_CONSUMER_SOURCE_GROUPS[0]!;const observed=new Map([...next.selectors,...(next.secondarySelectors??[])].map(row=>[sourceBindingKey(row),row.sha256]));expect(selectGitHubSourceBindingGroup(CI_CONSUMER_SOURCE_GROUPS,observed)).toBe(next);
 const legacy=CONSUMER_SOURCE_GROUPS[0]!.selectors.find(row=>row.path.includes('archive-consumer'))!;observed.set(sourceBindingKey(legacy),legacy.sha256);expect(()=>selectGitHubSourceBindingGroup(CI_CONSUMER_SOURCE_GROUPS,observed)).toThrow();
});

test('fixed preinstall reusable workflow selects a separate exact group and retains old metadata scope',async()=>{
 expect(CI_CONSUMER_SOURCE_GROUPS).toHaveLength(58);
 expect(githubOriginFacts(await scenario('prepublish'))?.workflowPath).toBe('.github/workflows/ci.yml');
 expect(githubOriginFacts(await scenario('prepublish',{legacyWorkflow:true}))?.workflowPath).toBe('.github/workflows/ci.yml');
 const actualOrigin=createHash('sha256').update(fs.readFileSync(path.join(root,'scripts/lib/independent-admission/github-origin.ts'))).digest('hex');
 const currentGroup=(workflow:string)=>CI_CONSUMER_SOURCE_GROUPS.find(group=>group.selectors.some(row=>row.path==='.github/workflows/independent-publication.yml'&&row.sha256===workflow)&&group.sourceBindings.some(row=>row.path==='scripts/lib/independent-admission/github-origin.ts'&&row.sha256===actualOrigin))!;
 const old=currentGroup(CALLABLE_PUBLICATION_WORKFLOW_SHA),fixed=currentGroup(STAGING_CHECKED_PUBLICATION_WORKFLOW_SHA);const tuple=new Map([...fixed!.selectors,...(fixed!.secondarySelectors??[])].map(row=>[sourceBindingKey(row),row.sha256]));
 expect(selectGitHubSourceBindingGroup(CI_CONSUMER_SOURCE_GROUPS,tuple)).toBe(fixed!);
 tuple.set(sourceBindingKey(old!.selectors[0]!), 'f'.repeat(64));expect(()=>selectGitHubSourceBindingGroup(CI_CONSUMER_SOURCE_GROUPS,tuple)).toThrow();
});
