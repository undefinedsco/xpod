import type {GitHubSourceBindingGroup} from './github-source-binding-groups';
/** Declaration belongs ONLY to an existing reviewed whole source group. No
 * standalone issuer/allowlist exists, and SDK1–20 declare no outer authority. */
export interface QleverSdkOuterExecutorContract {
 readonly schemaVersion:1;
 readonly model:'reviewed-run-outer-controller-v1';
 readonly workflowPath:string;
 readonly workflowSha256:string;
 readonly additionalWorkflows?:readonly Readonly<{path:string;sha256:string}>[];
 readonly collector:Readonly<{path:'qlever/scripts/sdk-readonly-executor.py';sha256:string}>;
 readonly uploadDomain:'RUNNER_TEMP/qlever-sdk-outer';
 readonly ownedSteps:readonly [string,string,string,string];
 readonly allowedBeforeController:readonly string[];
}
export interface QleverSdkOuterExecutorOriginAuthority {
 readonly schemaVersion:1;readonly model:'reviewed-run-outer-controller-v1';
 readonly sourceSha:string;readonly runHeadSha:string;readonly runId:number;readonly runAttempt:number;
 readonly target:string;readonly producerJobId:number;readonly artifactId:number;readonly artifactSha256:string;
 readonly workflowPath:string;readonly workflowSha256:string;readonly collectorSha256:string;
 readonly uploadDomain:'RUNNER_TEMP/qlever-sdk-outer';
 readonly stepWindows:readonly Readonly<{name:string;number:number;startedUnixMs:number;completedUnixMs:number}>[];
}
function need(value:unknown,why:string):asserts value {if(!value)throw Error('SDK outer origin: '+why);}
/** Pure metadata check; only observeGitHubOrigin can attach its output to its
 * existing private issued observation. Supplying this JSON never issues a cap. */
export function inspectReviewedSdkOuterExecutorOrigin(input:{group:GitHubSourceBindingGroup|undefined;workflowPath:string;workflowSha256:string;job:any;artifactCreatedAt:string;identity:{sourceSha:string;runHeadSha:string;runId:number;runAttempt:number;target?:string;artifactId:number;artifactSha256:string}}):QleverSdkOuterExecutorOriginAuthority|undefined {
 const rule=input.group?.outerExecutor;
 if(!rule)return undefined;
 const callers=[{path:rule.workflowPath,sha256:rule.workflowSha256},...(rule.additionalWorkflows??[])];
 need(callers.length===new Set(callers.map(row=>row.path)).size&&callers.length<=3&&callers.every(row=>['.github/workflows/publish-qlever-runtime-sdk.yml','.github/workflows/css-native-products.yml','.github/workflows/candidate.yml'].includes(row.path)),'unique fixed standalone/nested caller contracts required');
 need(rule.schemaVersion===1&&rule.model==='reviewed-run-outer-controller-v1'&&callers.some(row=>row.path===input.workflowPath&&row.sha256===input.workflowSha256)&&rule.uploadDomain==='RUNNER_TEMP/qlever-sdk-outer','exact reviewed workflow/upload boundary required');
 if(input.workflowPath!==rule.workflowPath)need(input.group!.sourceBindings.some(row=>row.path===input.workflowPath&&row.sha256===input.workflowSha256&&!row.reviewedSha256?.length),'nested caller belongs to the same exact whole source group');
 const collector=input.group!.sourceBindings.find(row=>row.path===rule.collector.path);
 need(rule.collector.path==='qlever/scripts/sdk-readonly-executor.py'&&collector?.sha256===rule.collector.sha256&&!collector.reviewedSha256?.length&&/^[a-f0-9]{64}$/u.test(rule.collector.sha256),'same whole source group fixed collector required');
 need(rule.ownedSteps.length===4&&new Set(rule.ownedSteps).size===4&&rule.ownedSteps.every(name=>typeof name==='string'&&name.length>0&&name.length<200),'four exact ordered controller steps required');
 const job=input.job,identity=input.identity;
 need(job?.id>0&&job.run_id===identity.runId&&job.run_attempt===identity.runAttempt&&job.head_sha===identity.runHeadSha&&job.status==='completed'&&job.conclusion==='success'&&Array.isArray(job.steps)&&['linux-x64','linux-arm64'].includes(identity.target??''),'same closed actual outer producer job required');
 const windows=rule.ownedSteps.map(name=>{
  const rows=job.steps.filter((row:any)=>row.name===name);need(rows.length===1,'unique actual outer stage required');const row=rows[0];const started=Date.parse(row.started_at),completed=Date.parse(row.completed_at);
  need(Number.isSafeInteger(row.number)&&row.number>0&&row.status==='completed'&&row.conclusion==='success'&&Number.isFinite(started)&&Number.isFinite(completed)&&started<=completed,'actual outer step closure required');
  return Object.freeze({name,number:row.number,startedUnixMs:started,completedUnixMs:completed});
 });
 for(let index=1;index<windows.length;index++)need(windows[index-1]!.number<windows[index]!.number&&windows[index-1]!.completedUnixMs<=windows[index]!.startedUnixMs,'controller/prepare/execute/seal order differs');
 const first=windows[0]!;need(job.steps.filter((row:any)=>row.number<first.number).every((row:any)=>rule.allowedBeforeController.includes(row.name)&&row.conclusion==='success'),'unreviewed host code ran before trusted controller');
 const start=Date.parse(job.started_at),end=Date.parse(job.completed_at),created=Date.parse(input.artifactCreatedAt);
 need(Number.isFinite(start)&&Number.isFinite(end)&&start<=first.startedUnixMs&&windows.at(-1)!.completedUnixMs<=end&&created>=windows.at(-1)!.startedUnixMs&&created<=end,'outer stage/artifact job window differs');
 return Object.freeze({schemaVersion:1,model:rule.model,...identity,target:identity.target!,producerJobId:job.id,workflowPath:input.workflowPath,workflowSha256:input.workflowSha256,collectorSha256:collector.sha256,uploadDomain:rule.uploadDomain,stepWindows:Object.freeze(windows)});
}
