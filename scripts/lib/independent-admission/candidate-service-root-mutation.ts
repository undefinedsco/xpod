import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {nativeOriginalsView,assertCollectedNativeOriginalCustody} from './native-original-collector';
import {isCandidateServiceImageGitHubOrigin} from './github-origin';
import {derivedSourceView,assertDerivedSourceCurrent} from './source-context';
import {readCandidateServiceRelationship} from './qlever-sdk-service-relationship';

const require=createRequire(import.meta.url);
const {deriveCandidate}=require('../../release-candidate.cjs');
const {applyPlatformOptionalDependencies}=require('../../platform-binaries.cjs');
const sha=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const MAXIMUM=128*1024;
function need(value:unknown,why:string):asserts value{if(!value)throw Error('Candidate service root mutation: '+why);}
function manifest(raw:Buffer):any{need(raw.length>0&&raw.length<=MAXIMUM,'bounded actual root manifest required');const value=JSON.parse(raw.toString());need(value&&typeof value==='object'&&!Array.isArray(value)&&value.name==='@undefineds.co/xpod','actual root identity');return value;}

/** Pure byte mechanics, not an issuer. The operational caller below supplies
 * the existing private GitHub run original and immutable Git source bytes. */
export function inspectCandidateRootMutation(input:{before:Buffer;after:Buffer;immutable:Buffer;run:any;sourceSha:string;runId:number;runAttempt:number}){
 const {run}=input;need(run&&run.id===input.runId&&run.run_attempt===input.runAttempt&&run.head_sha===input.sourceSha&&run.head_branch==='staging'&&['push','workflow_dispatch'].includes(run.event)&&Number.isSafeInteger(run.run_number)&&run.run_number>0,'actual same staging run/head/attempt/number');
 need(input.before.equals(input.immutable),'before differs from immutable Git root');
 const before=manifest(input.before),after=manifest(input.after);
 const candidate=deriveCandidate({branch:'staging',version:before.version,runNumber:run.run_number,runAttempt:input.runAttempt,sha:input.sourceSha});
 const expected=applyPlatformOptionalDependencies({...before,version:candidate.candidateVersion},candidate.candidateVersion);
 need(isDeepStrictEqual(after,expected),'unexpected root mutation outside candidate/platform SSOT');
 return Object.freeze({candidateVersion:candidate.candidateVersion,beforeSha256:sha(input.before),afterSha256:sha(input.after),rootCandidateMutationVerified:true as const});
}

/** Same native/source private issuers; no serialized report can enter here.
 * This proves one mutation axis, not service pack output, ABI or legal scope. */
export function observeCandidateServiceRootMutation(input:{originals:unknown;source:unknown}){
 const view=nativeOriginalsView(input.originals),source=derivedSourceView(input.source);
 need(view&&source&&isCandidateServiceImageGitHubOrigin(view.origin)&&source.sourceSha===view.originFacts.sourceSha,'same issued candidate service/source originals required');
 const guard=()=>{need(nativeOriginalsView(input.originals)===view&&derivedSourceView(input.source)===source&&isCandidateServiceImageGitHubOrigin(view.origin),'private original/source handle changed');assertCollectedNativeOriginalCustody(input.originals);assertDerivedSourceCurrent(input.source);};
 function checkClosure(){
  // Bind the executable pure transformation closure to the very immutable
  // source being observed, rather than silently applying a future recipe.
  need(source!.readTracked('scripts/lib/independent-admission/candidate-service-root-mutation.ts').equals(readFileSync(new URL('./candidate-service-root-mutation.ts',import.meta.url))),'root mutation observer/source bytes differ');
  for(const name of ['release-candidate.cjs','platform-binaries.cjs'])need(source!.readTracked('scripts/'+name).equals(readFileSync(new URL('../../'+name,import.meta.url))),'reviewed mutation helper/source bytes differ');
 }
 guard();checkClosure();
 const roots=new Map<string,{reference:{path:string;bytes:number;sha256:string};raw:Buffer}>();
 function inspect(){
  guard();checkClosure();
  const relation=readCandidateServiceRelationship(input.originals);
  const rows=view!.metadataOriginals.filter(row=>row.name==='run.original.json');need(rows.length===1,'unique actual run original');
  const read=(ref:any)=>{need(ref&&ref.bytes>0&&ref.bytes<=MAXIMUM,'bounded root original reference');const member=view!.members.find(row=>row.path===ref.path);need(member&&member.bytes===ref.bytes&&member.sha256===ref.sha256,'root reference outside retained closed set');const prior=roots.get(ref.path);if(prior){need(isDeepStrictEqual(prior.reference,{path:ref.path,bytes:ref.bytes,sha256:ref.sha256}),'root original reference changed');need(view!.readOriginalRange(ref.path,0,0).length===0,'root custody range changed');return prior.raw;}const raw=view!.readOriginal(ref.path,MAXIMUM);need(raw.length===ref.bytes&&sha(raw)===ref.sha256,'actual root original drift');roots.set(ref.path,{reference:{path:ref.path,bytes:ref.bytes,sha256:ref.sha256},raw:Buffer.from(raw)});return raw;};
  const facts=inspectCandidateRootMutation({before:read(relation.master.sourceOriginals.rootManifestBefore),after:read(relation.master.sourceOriginals.rootManifestAfter),immutable:source!.readTracked('package.json'),run:JSON.parse(rows[0]!.data.toString()),sourceSha:relation.sourceSha,runId:relation.runId,runAttempt:relation.runAttempt});guard();return facts;
 }
 const facts=inspect();
 return Object.freeze({facts,pending:Object.freeze(['candidate-service-pack-manifest-output-binding-unverified']),wholeServiceSourceVerified:false as const,serviceAbiVerified:false as const,assertCurrent(){need(isDeepStrictEqual(inspect(),facts),'root mutation observation changed');}});
}
