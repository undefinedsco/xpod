import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
import {readFileSync,realpathSync,mkdirSync,mkdtempSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {collectedArtifactView} from './artifact-collector';
import {derivedSourceView,assertDerivedSourceCurrent} from './source-context';
import {nativeOriginalsView,assertCollectedNativeOriginalCustody} from './native-original-collector';
import {inspectModuleNativeMaterials} from './native-module-materials';
import {captureLegalFileIdentity,assertLegalFileIdentity,resolveExecutableIdentityPath} from './legal-file-custody';
import {readSignatureOriginal} from './qlever-signature-original-custody';
import limits from '../module-artifact-limits.json';
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function need(value:unknown,reason:string):asserts value{if(!value)throw Error('AFS source originals: '+reason);}
/** This observer proves retained byte/source-set facts only. It cannot mint a
 * material capability or claim compiler/SDK/upstream origin authority. */
export async function observeAfsSourceOriginals(input:{artifact:unknown;source:unknown;nativeOriginals:unknown;remainingMilliseconds?:number}){
 const facts:Record<string,unknown>={afsNativeSourceClosureVerified:false},pending=new Set<string>();let retainedDirectory:string|undefined;
 try{
  const product=collectedArtifactView(input.artifact),source=derivedSourceView(input.source),native=nativeOriginalsView(input.nativeOriginals);
  need(product&&source&&native&&product.identity.target&&product.identity.sourceSha===source.sourceSha,'same issued normal product/source/native originals required');
  const remaining=input.remainingMilliseconds??limits.timeoutMs;need(Number.isFinite(remaining)&&remaining>0,'shared source deadline required');
  const deadline=performance.now()+Math.min(remaining,limits.timeoutMs),check=()=>need(performance.now()<deadline,'shared source deadline expired');
  const current=()=>{check();need(collectedArtifactView(input.artifact)===product&&derivedSourceView(input.source)===source&&nativeOriginalsView(input.nativeOriginals)===native,'private original custody revoked');assertDerivedSourceCurrent(input.source);assertCollectedNativeOriginalCustody(input.nativeOriginals);};current();
  const pins=source.readTracked('scripts/agentfs-native-ci/mounted/native-authority.json'),authority=JSON.parse(pins.toString());
  const material=inspectModuleNativeMaterials({module:'afs',target:product.identity.target,members:product.members,readMember:product.readMember,sourcePins:pins,nativePolicySource:source.readTracked('scripts/agentfs-native-ci/accept.py')});
  const selected=authority.artifacts?.[product.identity.target],origin=native.originFacts;
  need(origin.workflowPath==='.github/workflows/agentfs-native-acceptance.yml'&&origin.sourceSha===material.nativeSourceSha&&origin.target===product.identity.target&&String(origin.runId)===String(authority.run)&&String(origin.artifactId)===String(selected?.id)&&origin.artifactSha256===selected?.zip,'actual native authority differs');
  const kitRef=native.members.find(row=>row.path==='source-kit.json');need(kitRef&&kitRef.bytes<=limits.metadataBytes&&kitRef.sha256===material.index.sha256,'same bounded source kit original required');
  const kitRaw=native.readOriginal(kitRef.path,limits.metadataBytes);need(hash(kitRaw)===kitRef.sha256,'source kit original changed');const kit=JSON.parse(kitRaw.toString());
  const packages=native.members.filter(row=>row.path.endsWith('-'+product.identity.target+'.tar.gz'));need(packages.length===1&&packages[0]!.sha256===selected.archive,'exact native package archive required');
  const repository=fileURLToPath(new URL('../../../',import.meta.url)),helper=path.join(repository,'scripts/lib/independent-admission/afs-source-originals.py');
  const helperIdentity=captureLegalFileIdentity(helper);need(helperIdentity.size<=BigInt(limits.metadataBytes),'bounded controller source observer required');const helperSha=hash(readFileSync(helper));
  const python=resolveExecutableIdentityPath('/usr/bin/python3'),pythonIdentity=captureLegalFileIdentity(python);
  const parent=path.join(repository,'.test-data/afs-source-observations');mkdirSync(parent,{recursive:true});const directory=mkdtempSync(path.join(parent,'observed-'));retainedDirectory=directory;
  const {runPublicationCommand}=createRequire(import.meta.url)('../afs-publication-command.cjs');
  const observed=await native.withArchiveFile(async original=>{
   current();assertLegalFileIdentity(helperIdentity);assertLegalFileIdentity(pythonIdentity);
   const available=deadline-performance.now();need(available>5000,'source observer close reserve unavailable');
   const outcome=await runPublicationCommand(python,['-I','-S','-B',helper,original.path,packages[0]!.path,String(available-5000)],{cwd:directory,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},evidence:directory,label:'afs-source-originals',timeoutMs:Math.floor(available-5000),rawLimit:65536});
   check();need(outcome.code===0&&!outcome.signal&&outcome.actualWait&&outcome.actualClose&&outcome.groupAbsent&&outcome.rawComplete&&outcome.rawClosedBeforeHash&&outcome.pipeEOF?.every(Boolean),'source observer process did not close');
   assertLegalFileIdentity(helperIdentity);assertLegalFileIdentity(pythonIdentity);need(hash(readFileSync(helper))===helperSha,'controller source observer changed');
   const raw=outcome.raw.map((ref:{path:string;bytes:number;sha256:string})=>{need(path.basename(ref.path)===ref.path,'fixed observer raw role required');return readSignatureOriginal(path.join(directory,ref.path),ref,65536,check).bytes;});
   return JSON.parse(raw[0]!.toString());
  },{check,remainingMs:()=>deadline-performance.now()});
  current();need(observed.schemaVersion===1&&observed.kind==='agentfs-source-original-byte-observation'&&observed.sourceKitSha256===kitRef.sha256&&observed.packageSha256===packages[0]!.sha256&&observed.source.path===material.sourceArchive.path&&observed.source.bytes===material.sourceArchive.sizeBytes&&observed.source.sha256===material.sourceArchive.sha256&&observed.source.files===kit.files.length,'actual nested source archive/product/index correspondence differs');
  facts.afsSourceArchiveMembershipVerified=true;facts.afsSourceArchiveOriginals=Object.freeze(observed);
  const recipeRows=kit.files.filter((row:any)=>row.path.startsWith('packages/xpod-cli/')||row.path.startsWith('patches/')||row.path.startsWith('original/helper/')||row.path.startsWith('helper/src/'));
  need(recipeRows.length>0,'retained helper/recipe sources required');
  const verifiedRecipePaths:string[]=[];
  for(const row of recipeRows){check();const gitPath=row.path.startsWith('original/helper/')?'tools/agentfs-pod/'+row.path.slice('original/helper/'.length):row.path.startsWith('helper/src/')?'tools/agentfs-pod/'+row.path.slice('helper/'.length):row.path.startsWith('patches/')?'tools/agentfs-pod/'+row.path:row.path;const original=source.readTracked(gitPath);need(original.length===row.sizeBytes&&hash(original)===row.sha256,'actual retained recipe/helper source differs from immutable Git: '+gitPath);verifiedRecipePaths.push(gitPath);}
  facts.afsRetainedHelperRecipeGitBytesVerified=true;
  facts.afsRetainedHelperRecipeGitPaths=Object.freeze(verifiedRecipePaths);
  facts.afsCompilerToolchainOriginalsVerified=false;
  // The old kit explicitly excludes these domains. No declaration, receipt
  // hash or successful rebuild alone proves their actual complete inputs.
  pending.add('agentfs-compiler-sdk-input-closure-not-fully-bound');
  pending.add('agentfs-original-compiler-distribution-and-sdk-source-inputs-unavailable');
  pending.add('agentfs-upstream-commit-tree-and-vendor-official-source-authority-unverified');
  if(product.identity.target.startsWith('darwin-'))pending.add('agentfs-macos-executed-loader-sdk-runtime-originals-unavailable');
  current();
 }catch(error){pending.add((error as Error).message);}
 const freeze=(value:unknown):void=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}};freeze(facts);
 return Object.freeze({verified:false as const,facts:Object.freeze(facts),pending:Object.freeze([...pending]),...(retainedDirectory?{retainedDirectory}:{})});
}
