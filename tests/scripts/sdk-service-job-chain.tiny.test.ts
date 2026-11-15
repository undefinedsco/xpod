import {test,expect} from 'bun:test';
import {inspectCandidateServiceJobChain as inspect,type CandidateServiceRelationshipContract} from '../../scripts/lib/independent-admission/qlever-sdk-service-relationship';
const contract:CandidateServiceRelationshipContract={schemaVersion:1,workflowPath:'.github/workflows/candidate.yml',workflowSha256:'a'.repeat(64),serviceJob:'build_image',localRuntimeJob:'publish_qlever_local_runtime / publish',sdkJob:'publish_qlever_runtime_sdk / readonly_publish / published_sdk / sdk'};
const sourceSha='b'.repeat(40),names=[contract.sdkJob,contract.localRuntimeJob,contract.serviceJob];
const jobs=()=>names.map((name,index)=>({name,id:index+1,run_id:12,run_attempt:2,head_sha:sourceSha,status:'completed',conclusion:'success',started_at:new Date(1000+index*2000).toISOString(),completed_at:new Date(2000+index*2000).toISOString()}));
const base=()=>({jobs:jobs(),contract,sourceSha,runId:12,runAttempt:2,producerJobId:3});
test('same-run exact three closed jobs prove only their actual metadata order',()=>{expect(inspect(base())).toEqual({sdkJobId:1,localRuntimeJobId:2,serviceJobId:3});});
test('missing, extra, wrong attempt/head/job, overlap and failed ancestors all reject',()=>{
 for(const change of [(v:ReturnType<typeof base>)=>v.jobs.pop(),(v:ReturnType<typeof base>)=>v.jobs.push({...v.jobs[0]!}),(v:ReturnType<typeof base>)=>v.jobs[0]!.run_attempt++,(v:ReturnType<typeof base>)=>v.jobs[0]!.head_sha='c'.repeat(40),(v:ReturnType<typeof base>)=>v.producerJobId=2,(v:ReturnType<typeof base>)=>v.jobs[1]!.started_at=new Date(1500).toISOString(),(v:ReturnType<typeof base>)=>v.jobs[0]!.conclusion='failure']){const value=base();change(value);expect(()=>inspect(value)).toThrow();}
});
