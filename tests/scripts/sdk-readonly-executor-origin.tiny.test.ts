import {test,expect} from 'bun:test';
import {inspectReviewedSdkOuterExecutorOrigin as inspect} from '../../scripts/lib/independent-admission/qlever-sdk-outer-authority';
import {qleverSdkOuterExecutorOriginAuthority} from '../../scripts/lib/independent-admission/qlever-sdk-originals';
function fixture():any {
 const sha='a'.repeat(64),head='b'.repeat(40),steps=['Verify controller','Prepare image','Execute readonly','Seal and upload'];
 return {group:{sourceBindings:[{path:'qlever/scripts/sdk-readonly-executor.py',sha256:sha}],outerExecutor:{schemaVersion:1,model:'reviewed-run-outer-controller-v1',workflowPath:'.github/workflows/publish-qlever-runtime-sdk.yml',workflowSha256:sha,collector:{path:'qlever/scripts/sdk-readonly-executor.py',sha256:sha},uploadDomain:'RUNNER_TEMP/qlever-sdk-outer',ownedSteps:steps,allowedBeforeController:['Set up job']}},workflowPath:'.github/workflows/publish-qlever-runtime-sdk.yml',workflowSha256:sha,identity:{sourceSha:head,runHeadSha:head,runId:12,runAttempt:2,target:'linux-arm64',artifactId:21,artifactSha256:sha},artifactCreatedAt:'2026-10-18T00:00:08Z',job:{id:9,run_id:12,run_attempt:2,head_sha:head,status:'completed',conclusion:'success',started_at:'2026-10-18T00:00:00Z',completed_at:'2026-10-18T00:00:10Z',steps:steps.map((name,i)=>({name,number:i+1,status:'completed',conclusion:'success',started_at:`2026-10-18T00:00:0${i*2}Z`,completed_at:`2026-10-18T00:00:0${i*2+1}Z`}))}};
}
test('reviewed outer metadata requires the complete exact job and source declaration',()=>{
 expect(inspect(fixture())?.producerJobId).toBe(9);
 for(const mutate of [(x:any)=>x.workflowSha256='c'.repeat(64),(x:any)=>x.group.sourceBindings[0].sha256='c'.repeat(64),(x:any)=>x.job.run_attempt=1,(x:any)=>x.job.steps[1].conclusion='failure',(x:any)=>x.job.steps.splice(1,1),(x:any)=>x.job.steps.push({...x.job.steps[0]}),(x:any)=>x.job.steps.unshift({name:'Run candidate install',number:0,conclusion:'success'}),(x:any)=>x.artifactCreatedAt='2026-10-18T00:00:01Z']){
  const value=fixture();mutate(value);expect(()=>inspect(value)).toThrow();
 }
});
test('historical groups and JSON metadata cannot enroll outer authority',()=>{
 const value=fixture();delete value.group.outerExecutor;expect(inspect(value)).toBeUndefined();
 expect(qleverSdkOuterExecutorOriginAuthority(fixture())).toBeUndefined();
});

test('nested caller requires exact separately declared immutable workflow in same source group',()=>{
 const value=fixture(),path='.github/workflows/css-native-products.yml',sha='d'.repeat(64);
 value.group.outerExecutor.additionalWorkflows=[{path,sha256:sha}];value.workflowPath=path;value.workflowSha256=sha;
 expect(()=>inspect(value)).toThrow();value.group.sourceBindings.push({path,sha256:sha});expect(inspect(value)?.workflowPath).toBe(path);
 value.workflowSha256='e'.repeat(64);expect(()=>inspect(value)).toThrow();value.workflowSha256=sha;value.group.outerExecutor.additionalWorkflows.push({path,sha256:sha});expect(()=>inspect(value)).toThrow();
});

test('exact service third caller joins its own whole source; fourth or unknown callers reject',()=>{
 const value=fixture(),sha='d'.repeat(64);const paths=['.github/workflows/css-native-products.yml','.github/workflows/candidate.yml'];value.group.outerExecutor.additionalWorkflows=paths.map(path=>({path,sha256:sha}));value.group.sourceBindings.push(...paths.map(path=>({path,sha256:sha})));value.workflowPath=paths[1];value.workflowSha256=sha;expect(inspect(value)?.workflowPath).toBe(paths[1]);
 value.group.outerExecutor.additionalWorkflows.push({path:'.github/workflows/unreviewed.yml',sha256:sha});expect(()=>inspect(value)).toThrow();value.group.outerExecutor.additionalWorkflows.pop();value.group.outerExecutor.additionalWorkflows[1].path='.github/workflows/unreviewed.yml';expect(()=>inspect(value)).toThrow();
});
