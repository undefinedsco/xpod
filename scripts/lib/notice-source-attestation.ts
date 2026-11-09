import {constants,openSync,closeSync,fstatSync,readSync,lstatSync,mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {createHash} from 'node:crypto';
const ROOT_SHA256='65ca537f6ed8a47fd0e560c421baa1f6c1efb8b25fc200d8c5c02c0e92eb2b9c';
const VERIFIERS=Object.freeze({
 x64:{bytes:42086560,sha256:'7469124f706944133d6a169691dd1c6c3511b12e85878d255e044e2948df4c9b',assetArch:'amd64',archiveBytes:15319960,archiveSHA256:'bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386'},
 arm64:{bytes:39059616,sha256:'93308395c2d296a63a662742c6366e4db413d2a4870d07bd9b84e491c065d65d',assetArch:'arm64',archiveBytes:13917794,archiveSHA256:'7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484'},
});
const sha=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const need=(value:unknown,message:string):void=>{if(!value)throw new Error(message);};
/** One program descriptor for normal acquisition and execution. Pure selection
 * is not host or source authority; the consumer always selects its actual host. */
export function reviewedNoticeVerifierPlan(platform:string=process.platform,architecture:string=process.arch){
 need(platform==='linux'&&(architecture==='x64'||architecture==='arm64'),'Matching Linux verifier host pending');
 const pin=VERIFIERS[architecture as keyof typeof VERIFIERS],version='2.102.0',prefix=`gh_${version}_linux_${pin.assetArch}`,asset=prefix+'.tar.gz';
 return Object.freeze({schemaVersion:1,kind:'reviewed-notice-verifier-plan',version,platform,architecture,
  archive:Object.freeze({path:'gh.official.tar.gz',bytes:pin.archiveBytes,sha256:pin.archiveSHA256,url:`https://github.com/cli/cli/releases/download/v${version}/${asset}`,member:prefix+'/bin/gh'}),
  executable:Object.freeze({path:'gh',bytes:pin.bytes,sha256:pin.sha256}),
  trustedRoot:Object.freeze({path:'trusted-root.original.jsonl',bytes:34634,sha256:ROOT_SHA256}),
  checksums:Object.freeze({path:'http/checksums.original.txt',bytes:1971,sha256:'afe49e9affa232faa8212aed035417166f6ade9b9470acb53d4dbd28c0504e8d',url:`https://github.com/cli/cli/releases/download/v${version}/gh_${version}_checksums.txt`})});
}
export function noticeVerifierRequired(index:unknown):boolean{const value=index as any;need(value?.schemaVersion===1&&Array.isArray(value.entries)&&value.entries.length<=512,'Bounded supplement index required');return value.entries.some((row:any)=>row?.sourceOriginals?.attestation!==undefined);}
const NOTICE_VERIFIER_HTTP_NAMES=Object.freeze(['http/release-metadata.original.json','http/release-response.headers.original.json','http/release-response.original.json','http/asset-response.headers.original.json','http/asset-response.original.json','http/checksum-response.headers.original.json','http/checksum-response.original.json']);
export function noticeVerifierOriginalNames(platform:string=process.platform,architecture:string=process.arch){const plan=reviewedNoticeVerifierPlan(platform,architecture);return Object.freeze(['acquisition.original.json',plan.archive.path,plan.executable.path,plan.trustedRoot.path,plan.checksums.path,'request.original.json',...NOTICE_VERIFIER_HTTP_NAMES]);}
/** Pure original-coordinate projection. Reads and source/job authority remain
 * with the existing producer and private collector; JSON creates no authority. */
export function noticeVerifierReceiptOriginals(receipt:any,platform:string=process.platform,architecture:string=process.arch){
 const plan=reviewedNoticeVerifierPlan(platform,architecture);
 need(receipt?.schemaVersion===1&&receipt.kind==='reviewed-notice-attestation-verifier-originals'&&receipt.authority===false&&isDeepStrictEqual(receipt.plan,plan),'Complete reviewed verifier receipt required');
 const fixed=[['archive',plan.archive],['executable',plan.executable],['trustedRoot',plan.trustedRoot],['checksums',plan.checksums]] as const;
 const rows:{path:string;bytes:number;sha256:string}[]=[];
 for(const [role,pin]of fixed){const ref=receipt[role];need(ref?.path===pin.path&&ref.bytes===pin.bytes&&ref.sha256===pin.sha256,'Fixed verifier original reference');rows.push({path:pin.path,bytes:pin.bytes,sha256:pin.sha256});}
 const names=NOTICE_VERIFIER_HTTP_NAMES;
 need(Array.isArray(receipt.acquisitionOriginals)&&receipt.acquisitionOriginals.length===names.length,'Complete verifier HTTP originals');
 for(const [index,name]of names.entries()){const ref=receipt.acquisitionOriginals[index];need(ref?.path===name&&Number.isSafeInteger(ref.bytes)&&ref.bytes>0&&ref.bytes<=512*1024&&/^[a-f0-9]{64}$/u.test(ref.sha256),'Verifier HTTP original reference');rows.push({path:name,bytes:ref.bytes,sha256:ref.sha256});}
 const request=receipt.request;need(request?.path==='request.original.json'&&Number.isSafeInteger(request.bytes)&&request.bytes>0&&request.bytes<=4096&&/^[a-f0-9]{64}$/u.test(request.sha256),'Verifier parent request reference');rows.push({path:request.path,bytes:request.bytes,sha256:request.sha256});
 need(Number.isSafeInteger(receipt.chargedBytesBeforeReceipt)&&receipt.chargedBytesBeforeReceipt===rows.reduce((sum,row)=>sum+row.bytes,0)&&receipt.chargedBytesBeforeReceipt<64*1024**2,'Verifier shared retained accounting');
 return Object.freeze({plan,originals:Object.freeze(rows.map(row=>Object.freeze(row)))});
}
export function verifyNoticeVerifierHttpOriginals(receipt:any,read:(name:string,maximum:number)=>Buffer,platform:string=process.platform,architecture:string=process.arch){
 const {plan,originals}=noticeVerifierReceiptOriginals(receipt,platform,architecture),get=(name:string)=>{const row=originals.find(row=>row.path===name)!;const raw=read(name,row.bytes);need(raw.length===row.bytes&&sha(raw)===row.sha256,'Verifier retained original digest');return raw;};
 const metadata=JSON.parse(get('http/release-metadata.original.json').toString('utf8')),assets=metadata.assets?.filter((row:any)=>row.browser_download_url===plan.archive.url);
 need(metadata.tag_name==='v'+plan.version&&Array.isArray(assets)&&assets.length===1&&assets[0].size===plan.archive.bytes&&assets[0].digest==='sha256:'+plan.archive.sha256,'Verifier official release identity');
 for(const [name,url,bodyPath]of [['http/release-response.original.json','https://api.github.com/repos/cli/cli/releases/tags/v'+plan.version,'http/release-metadata.original.json'],['http/asset-response.original.json',plan.archive.url,plan.archive.path],['http/checksum-response.original.json',plan.checksums.url,plan.checksums.path]]){const response=JSON.parse(get(name!).toString('utf8')),body=originals.find(row=>row.path===bodyPath)!;need(response.url===url&&response.status===200&&isDeepStrictEqual(response.body,body),'Verifier actual HTTP/body original relation');const header=JSON.parse(get(name!.replace('.original.json','.headers.original.json')).toString('utf8'));need(isDeepStrictEqual(header,{url:response.url,status:response.status,contentType:response.contentType,contentLength:response.contentLength}),'Verifier HTTP header/body capture differs');}
 const checksums=get(plan.checksums.path),asset=path.posix.basename(new URL(plan.archive.url).pathname),lines=checksums.toString('utf8').trim().split('\n').filter(line=>line.endsWith('  '+asset));need(lines.length===1&&lines[0]===plan.archive.sha256+'  '+asset,'Verifier official checksum entry');
 return originals;
}
export type NoticeSourceAttestationPolicy=Readonly<{repository:string;commit:string;workflow:string;ref:string;packageName:string;packageVersion:string}>;
/** This declaration selects an ecosystem verifier policy, never an issued cap.
 * Caller verification reports are deliberately absent from this interface. */
export function noticeAttestationPolicy(input:NoticeSourceAttestationPolicy):readonly string[]{
 need(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository)&&input.repository.split('/').every(part=>part!=='.'&&part!=='..'),'Attestation repository');
 need(/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/u.test(input.packageName)&&/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.+-]+)?$/u.test(input.packageVersion),'Attestation package identity');
 need(/^[a-f0-9]{40}$/u.test(input.commit),'Attestation source commit');
 need(/^refs\/heads\/[A-Za-z0-9_.\/-]+$/u.test(input.ref)&&!input.ref.includes('..'),'Attestation source ref');
 need(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u.test(input.workflow),'Attestation workflow');
 return ['--repo',input.repository,'--digest-alg','sha512','--predicate-type','https://slsa.dev/provenance/v1','--cert-identity',`https://github.com/${input.repository}/${input.workflow}@${input.ref}`,'--cert-oidc-issuer','https://token.actions.githubusercontent.com','--source-digest',input.commit,'--source-ref',input.ref,'--deny-self-hosted-runners','--format','json'];
}
export function noticeAttestationBundle(response:Buffer):Buffer{
 need(response.length<=512*1024,'Attestation response budget');
 const parsed=JSON.parse(response.toString('utf8'));
 const rows=parsed?.attestations?.filter((row:any)=>row.predicateType==='https://slsa.dev/provenance/v1');
 need(Array.isArray(rows)&&rows.length===1&&rows[0].bundle?.mediaType==='application/vnd.dev.sigstore.bundle.v0.3+json','Unique SLSA bundle required');
 const raw=Buffer.from(JSON.stringify(rows[0].bundle));need(raw.length<=512*1024,'Attestation bundle budget');return raw;
}
export function noticeVerifiedStatementMatches(statement:any,policy:NoticeSourceAttestationPolicy,artifact:Buffer):boolean{
 const repo='https://github.com/'+policy.repository,build=statement?.predicate?.buildDefinition,workflow=build?.externalParameters?.workflow;
 const expectedName='pkg:npm/'+policy.packageName.split('/').map(encodeURIComponent).join('/')+'@'+encodeURIComponent(policy.packageVersion);
 const dependencies=build?.resolvedDependencies;
 return statement?._type==='https://in-toto.io/Statement/v1'&&statement.predicateType==='https://slsa.dev/provenance/v1'&&build?.buildType==='https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1'&&workflow?.repository===repo&&workflow.path===policy.workflow&&workflow.ref===policy.ref&&Array.isArray(dependencies)&&dependencies.filter((row:any)=>row.uri==='git+'+repo+'@'+policy.ref).length===1&&dependencies.some((row:any)=>row.uri==='git+'+repo+'@'+policy.ref&&row.digest?.gitCommit===policy.commit)&&Array.isArray(statement.subject)&&statement.subject.length===1&&statement.subject[0]?.name===expectedName&&statement.subject[0]?.digest?.sha512===createHash('sha512').update(artifact).digest('hex');
}
function reviewedExecutable(filename:string,check:()=>void):Buffer{
 need(process.platform==='linux'&&(process.arch==='x64'||process.arch==='arm64'),'Matching Linux verifier host pending');
 const pin=VERIFIERS[process.arch as keyof typeof VERIFIERS];
 need(path.isAbsolute(filename)&&!lstatSync(filename).isSymbolicLink(),'Verifier canonical regular original required');
 const fd=openSync(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 const identity=(s:any)=>[s.dev,s.ino,s.mode,s.size,s.mtimeNs,s.ctimeNs,s.nlink].join(':');
 try{const first=fstatSync(fd,{bigint:true});need(first.isFile()&&first.size===BigInt(pin.bytes),'Reviewed verifier byte size');const parts:Buffer[]=[];let total=0;
  while(total<pin.bytes){check();const block=Buffer.alloc(Math.min(65536,pin.bytes-total));const count=readSync(fd,block,0,block.length,null);need(count>0,'Verifier short original');parts.push(block.subarray(0,count));total+=count;}
  const extra=Buffer.alloc(1);need(readSync(fd,extra,0,1,null)===0,'Verifier grew');const body=Buffer.concat(parts,total);
  need(identity(first)===identity(fstatSync(fd,{bigint:true}))&&identity(first)===identity(lstatSync(filename,{bigint:true}))&&sha(body)===pin.sha256,'Reviewed verifier identity/SHA mismatch');return body;
 }finally{closeSync(fd);}
}
/** Re-executes the pinned official gh implementation offline. Success proves
 * this artifact's signed source relationship only, not legal/ABI/dependency
 * closure. The existing caller/private admission remains the sole issuer. */
export function verifyNoticeSourceAttestation(input:Readonly<{policy:NoticeSourceAttestationPolicy;artifact:Buffer;integrity:string;response:Buffer;trustedRoot:Buffer;verifierPath:string;workRoot:string;remainingMilliseconds:()=>number}>){
 const end=Date.now()+Math.min(90000,input.remainingMilliseconds());
 const remaining=()=>{const n=Math.min(end-Date.now(),input.remainingMilliseconds());need(Number.isFinite(n)&&n>0,'Attestation absolute deadline');return Math.max(1,Math.floor(n));};
 remaining();need(input.artifact.length>0&&input.artifact.length<=128*1024**2,'Attestation artifact budget');
 need(input.integrity==='sha512-'+createHash('sha512').update(input.artifact).digest('base64'),'Attestation artifact lock SRI');
 need(input.trustedRoot.length<=512*1024&&sha(input.trustedRoot)===ROOT_SHA256,'Reviewed TUF trusted-root original required');
 const args=noticeAttestationPolicy(input.policy),bundle=noticeAttestationBundle(input.response),binary=reviewedExecutable(input.verifierPath,()=>{remaining();});
 need(lstatSync(input.workRoot).isDirectory()&&!lstatSync(input.workRoot).isSymbolicLink(),'Attestation owned work directory');
 const temporary=mkdtempSync(path.join(input.workRoot,'.notice-attestation-'));
 try{
  const files={verifier:'gh',artifact:'artifact.tgz',bundle:'bundle.json',root:'trusted-root.jsonl'};
  for(const [name,body] of Object.entries({verifier:binary,artifact:input.artifact,bundle,root:input.trustedRoot})){remaining();writeFileSync(path.join(temporary,files[name as keyof typeof files]),body,{flag:'wx',mode:0o400});}
  const executable=path.join(temporary,files.verifier);chmodSync(executable,0o500);
  const command=['attestation','verify',path.join(temporary,files.artifact),'--bundle',path.join(temporary,files.bundle),'--custom-trusted-root',path.join(temporary,files.root),...args];
  const result=spawnSync(executable,command,{cwd:temporary,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',GH_CONFIG_DIR:temporary,GH_HOST:'github.com',CODESPACES:'true',GH_PROMPT_DISABLED:'1',GH_NO_UPDATE_NOTIFIER:'1'},timeout:remaining(),maxBuffer:1024*1024,encoding:'buffer'});
  let deadlineExpired=false;try{remaining();}catch{deadlineExpired=true;}
  if(deadlineExpired||result.error||result.status!==0||result.signal!==null)throw Object.assign(new Error('Official offline attestation verification failed'),{observation:Object.freeze({actualExit:result.status,signal:result.signal,executionErrorCode:result.error?(result.error as NodeJS.ErrnoException).code??'UNKNOWN':undefined,deadlineExpired,stdoutOriginal:result.stdout,stderrOriginal:result.stderr,artifactSHA256:sha(input.artifact),responseSHA256:sha(input.response),trustedRootSHA256:ROOT_SHA256,verifierSHA256:sha(binary)})});
  const rows=JSON.parse(result.stdout.toString('utf8'));
  need(Array.isArray(rows)&&rows.length===1&&rows[0]?.verificationResult?.verifiedTimestamps?.some((v:any)=>v.type==='Tlog'),'Verified transparency timestamp required');
  need(noticeVerifiedStatementMatches(rows[0].verificationResult.statement,input.policy,input.artifact),'Verified statement source/workflow/package subject differs');
  return Object.freeze({scope:'signed-artifact-source-relationship' as const,repository:input.policy.repository,commit:input.policy.commit,artifactSHA256:sha(input.artifact),responseSHA256:sha(input.response),trustedRootSHA256:ROOT_SHA256,verifierSHA256:sha(binary),verificationOriginal:result.stdout as Buffer,stderrOriginal:result.stderr as Buffer,legalClearance:false as const,wholeSourceVerified:false as const});
 }finally{rmSync(temporary,{recursive:true,force:true});}
}
