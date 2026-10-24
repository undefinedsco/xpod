import {inspectServiceOutputStage} from './candidate-service-output-stage';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {nativeOriginalsView,assertCollectedNativeOriginalCustody} from './native-original-collector';
import {derivedSourceView,assertDerivedSourceCurrent} from './source-context';
import {isCandidateServiceImageGitHubOrigin} from './github-origin';
import {readCandidateServiceRelationship} from './qlever-sdk-service-relationship';
import {observeCandidateServiceRootMutation} from './candidate-service-root-mutation';
import {captureLegalFileIdentity,assertLegalFileIdentity,type LegalFileIdentity} from './legal-file-custody';
const require=createRequire(import.meta.url),{parseTar}=require('../../workspace-package-payload.cjs');
const sha=(raw:Buffer)=>createHash('sha256').update(raw).digest('hex');
const MAX=4*1024**2,TAR=256*1024,MANIFEST=128*1024;
const SOURCE_ROOT=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
const OBSERVER_PATH='scripts/lib/independent-admission/candidate-service-image-output.ts';
const MUTATION_PATH='scripts/lib/independent-admission/candidate-service-root-mutation.ts';
const EXECUTED_PATHS=[OBSERVER_PATH,MUTATION_PATH,'scripts/lib/independent-admission/candidate-service-output-stage.ts','qlever/scripts/sdk-service-image-originals.py','qlever/scripts/sdk-service-pack-bindings.py','scripts/lib/module-artifact-limits.json','scripts/workspace-package-payload.cjs'] as const;
const ROLES=['pull','create','inspect','copy','remove','confirm-absent'] as const;
function need(value:unknown,why:string):asserts value{if(!value)throw Error('Candidate service image output: '+why);}
function fixedPath(value:unknown):value is string{return typeof value==='string'&&value.startsWith('/')&&!/[\u0000-\u001f\u007f\\]/u.test(value)&&!value.split('/').some(part=>part==='.'||part==='..');}

/** Pure retained-byte mechanics only; not a capability constructor. The private
 * operational entry supplies all refs, actual job window and mutation facts. */
export function inspectCandidateServiceImageOutput(input:{master:any;read:(ref:any,maximum:number)=>Buffer;candidateVersion:string;job:{started_at:string;completed_at:string}}){
 const {master}=input,record=master.outputImageObservation;
 need(record?.schemaVersion===1&&record.kind==='actual-stopped-service-image-root-manifest','explicit actual output observation required');
 need(/^ghcr\.io\/undefinedsco\/xpod@sha256:[a-f0-9]{64}$/u.test(master.serviceImageReferenceByDigest)&&record.imageReferenceByDigest===master.serviceImageReferenceByDigest&&record.configDigest===master.images?.service?.configDigest&&/^sha256:[a-f0-9]{64}$/u.test(record.configDigest),'exact same actual service image/config');
 need(typeof record.containerId==='string'&&/^[a-f0-9]{64}$/u.test(record.containerId)&&typeof record.ownerNonce==='string'&&/^[a-f0-9]{32}$/u.test(record.ownerNonce)&&record.containerName==='xpod-service-output-'+record.ownerNonce,'full owned CID/name/nonce');
 need(fixedPath(master.sourcePath)&&master.controllerPath===master.sourcePath+'/qlever/scripts/sdk-service-image-originals.py'&&/^[a-f0-9]{40}$/u.test(master.sourceSha),'fixed actual collector source path');
 need(Array.isArray(record.stages)&&isDeepStrictEqual(record.stages.map((row:any)=>row.name),ROLES.map(role=>'service-output-'+role)),'exact complete six-stage universe');
 const start=Date.parse(input.job.started_at)*1e6,end=Date.parse(input.job.completed_at)*1e6;need(Number.isFinite(start)&&Number.isFinite(end)&&start<=end,'actual closed producing job window');let last=start;
 const raws=new Map<string,Buffer>();
 for(const [index,role] of ROLES.entries()){
  const stage=record.stages[index],label='service-output-'+role;
  need(isDeepStrictEqual(stage.inputs,[])&&isDeepStrictEqual(stage.outputs,[]),'fixed output observation has no caller inputs or output declarations');
  const command=['/usr/bin/python3','-I','-S','-B',master.controllerPath,'--source',master.sourcePath,'--source-sha',master.sourceSha,'--image-worker',role,'--service-image',record.imageReferenceByDigest,'--container-name',record.containerName,'--owner-nonce',record.ownerNonce,...(index>=2?['--container-id',record.containerId]:[])];
  const observed=inspectServiceOutputStage({stage,label,command,sourcePath:master.sourcePath,stdoutMaximum:role==='copy'?TAR:MAX,read:input.read,jobStartNs:start,jobEndNs:end,startedAfterNs:last});last=observed.completedUnixNs;need(observed.stdout,'complete actual image stdout required');raws.set(role,observed.stdout);
 }
 const collectionHead=master.stages?.[0];need(collectionHead?.name==='service-source-head','actual collector start stage missing');
 const collectionStart=JSON.parse(input.read(collectionHead.receipt,MAX).toString()).startedUnixNs;
 need(Number.isInteger(collectionStart)&&start<=collectionStart&&collectionStart<=last&&last-collectionStart<=120*1e9,'actual collector shared 120-second interval exceeded');
 need(raws.get('create')!.equals(Buffer.from(record.containerId+'\n')),'create actual stdout CID differs');
 const actual=JSON.parse(raws.get('inspect')!.toString());
 need(actual?.Id===record.containerId&&actual.Image===record.configDigest&&actual.Name==='/'+record.containerName&&actual.Config?.Image===record.imageReferenceByDigest&&actual.Config?.Labels?.['xpod.service-output-owner']===record.ownerNonce,'actual inspected CID/image/config/nonce/name differs');
 need(actual.State?.Running===false&&actual.State.Status==='created'&&actual.State.Pid===0&&actual.State.StartedAt==='0001-01-01T00:00:00Z','actual stopped image output must never have started');
 const tar=raws.get('copy')!;need(tar.length>0&&tar.length<=TAR,'bounded original Docker copy stream');const members=parseTar(tar,{members:1});
 need(members.length===1&&members[0].path==='package.json'&&members[0].type==='file'&&members[0].size>0&&members[0].size<=MANIFEST,'single regular actual package.json tar member');
 const ref=master.sourceOriginals?.serviceRootManifest;need(ref?.path==='output/service-root-package.original.json','fixed actual extracted original path');const body=input.read(ref,MANIFEST);need(body.equals(members[0].content),'actual tar member differs from retained manifest original');
 const text=body.toString('utf8');need(Buffer.from(text).equals(body),'actual UTF-8 output manifest');const manifest=JSON.parse(text);
 need(manifest&&typeof manifest==='object'&&!Array.isArray(manifest)&&manifest.name==='@undefineds.co/xpod'&&manifest.version===input.candidateVersion,'actual image manifest namespace/candidate version differs');
 need(raws.get('remove')!.toString().trim()===record.containerId&&raws.get('confirm-absent')!.length===0,'actual owned container removal/absence not closed');
 return Object.freeze({imageManifestVersionBound:true as const,candidateVersion:input.candidateVersion,imageReferenceByDigest:record.imageReferenceByDigest,configDigest:record.configDigest,manifestSha256:sha(body),manifestBytes:body.length,copyTarSha256:sha(tar),packManifestTransformationVerified:false as const});
}

/** Same existing private native/source handles and internal mutation observer;
 * caller JSON facts cannot substitute for an issued original or source. */
export function observeCandidateServiceImageOutput(input:{originals:unknown;source:unknown}){
 const view=nativeOriginalsView(input.originals),source=derivedSourceView(input.source);
 need(view&&source&&isCandidateServiceImageGitHubOrigin(view.origin)&&source.sourceSha===view.originFacts.sourceSha,'same issued candidate service/source originals required');
 // A historical whole-source group must never acquire future observer code.
 // Missing tracked closure is pending at the caller; no source read or private
 // mutation observer may happen before this immutable tree check.
 if(!EXECUTED_PATHS.every(path=>source.trackedPaths.includes(path)))return undefined;
 const mutation=observeCandidateServiceRootMutation(input);
 const guard=()=>{need(nativeOriginalsView(input.originals)===view&&derivedSourceView(input.source)===source&&isCandidateServiceImageGitHubOrigin(view.origin),'private original/source handle changed');assertCollectedNativeOriginalCustody(input.originals);assertDerivedSourceCurrent(input.source);mutation.assertCurrent();};
 // Hot path: the full stage/master/root-manifest/copy structural validation runs
 // exactly ONCE per private observation. Every later nested getter re-proves
 // live custody instead (retained archive/descriptor lifetime, source HEAD and
 // cleanliness, relationship seal, and captured runtime-helper file identities),
 // so an actual change still refuses. Cached manifest bytes are returned only as
 // defensive copies and are never serialized as authority.
 let validated:{readonly facts:any;readonly reference:Readonly<{path:string;bytes:number;sha256:string}>;readonly manifest:Buffer}|undefined;
 let helperIdentities:readonly LegalFileIdentity[]|undefined;
 const liveCustody=()=>{
  need(nativeOriginalsView(input.originals)===view&&derivedSourceView(input.source)===source&&isCandidateServiceImageGitHubOrigin(view.origin),'private original/source handle changed');
  assertCollectedNativeOriginalCustody(input.originals);
  assertDerivedSourceCurrent(input.source);
  // The relationship read re-proves the native lifetime/descriptor custody and
  // the exact master seal without re-walking the unchanged structural graph.
  readCandidateServiceRelationship(input.originals);
  for(const identity of helperIdentities!)assertLegalFileIdentity(identity);
 };
 const inspect=()=>{
  if(validated){liveCustody();return {facts:validated.facts,reference:validated.reference,manifest:Buffer.from(validated.manifest)};}
  guard();for(const path of EXECUTED_PATHS)need(source.readTracked(path).equals(readFileSync(resolve(SOURCE_ROOT,path))),'immutable image observer/producer/parser executable source differs');
  const identities=EXECUTED_PATHS.map(path=>captureLegalFileIdentity(resolve(SOURCE_ROOT,path)));
  const relation=readCandidateServiceRelationship(input.originals),jobs=view.metadataOriginals.filter(row=>/^jobs(?:-page-\d+)?\.original\.json$/u.test(row.name)).flatMap(row=>JSON.parse(row.data.toString()).jobs??[]),selected=jobs.filter((row:any)=>row.id===view.originFacts.producerJobId);need(selected.length===1,'unique actual same service job');
  const read=(ref:any,maximum:number)=>{need(ref&&Number.isSafeInteger(ref.bytes)&&ref.bytes>=0&&ref.bytes<=maximum&&typeof ref.path==='string','bounded actual output ref');const rows=view.members.filter(row=>row.path===ref.path);need(rows.length===1&&rows[0]!.bytes===ref.bytes&&rows[0]!.sha256===ref.sha256,'output reference outside actual retained closed set');const raw=view.readOriginal(ref.path,maximum);need(raw.length===ref.bytes&&sha(raw)===ref.sha256,'actual output original bytes drift');return raw;};
  const facts=inspectCandidateServiceImageOutput({master:relation.master,read,candidateVersion:mutation.facts.candidateVersion,job:selected[0]});const reference=relation.master.sourceOriginals.serviceRootManifest;const manifest=read(reference,MANIFEST);guard();
  helperIdentities=Object.freeze(identities);validated=Object.freeze({facts,reference:Object.freeze({path:reference.path as string,bytes:reference.bytes as number,sha256:reference.sha256 as string}),manifest:Buffer.from(manifest)});
  return {facts:validated.facts,reference:validated.reference,manifest:Buffer.from(validated.manifest)};
 };
 const initial=inspect(),facts=initial.facts;return Object.freeze({facts,pending:Object.freeze(['candidate-service-pack-manifest-transformation-unverified','candidate-service-whole-source-closure-unverified','candidate-service-runtime-abi-unverified','candidate-service-legal-coverage-unverified']),wholeServiceSourceVerified:false as const,serviceAbiVerified:false as const,assertCurrent(){need(isDeepStrictEqual(inspect().facts,facts),'actual image output observation changed');},readManifestOriginal(){const current=inspect();need(isDeepStrictEqual(current.facts,facts)&&isDeepStrictEqual(current.reference,initial.reference)&&current.manifest.equals(initial.manifest),'actual image manifest original changed');return Object.freeze({reference:current.reference,bytes:Buffer.from(current.manifest)});}});
}
