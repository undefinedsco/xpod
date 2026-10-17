import {collectedArtifactView} from './artifact-collector';
import {derivedSourceView,assertDerivedSourceCurrent} from './source-context';
import {inspectModuleNativeMaterials} from './native-module-materials';
import type {ArtifactAcquisitionInput} from '../../acquire-independent-product-input';
const need=(value:unknown,reason:string):void=>{if(!value)throw Error('AFS native acquisition: '+reason);};
/** Data locator only. The existing GitHub origin issuer still validates every
 * source/workflow/job/attempt/window before any native capability is issued. */
export async function observeAfsNativeAcquisition(input:{artifact:unknown;source:unknown;token?:string}):Promise<Readonly<{coordinates:ArtifactAcquisitionInput;target:string;metadataOriginals:readonly Readonly<{name:string;data:Buffer}>[]}>>{
 const product=collectedArtifactView(input.artifact),source=derivedSourceView(input.source);
 need(product&&source&&product.identity.sourceSha===source.sourceSha&&/^@undefineds\.co\/xpod-afs-(?:linux|darwin)-(?:x64|arm64)$/u.test(product.identity.package),'same issued normal AFS product/source required');
 if(!product||!source||!product.identity.target)throw Error('AFS native acquisition: canonical target required');
 assertDerivedSourceCurrent(input.source);
 const pinsBytes=source.readTracked('scripts/agentfs-native-ci/mounted/native-authority.json');
 const pins=JSON.parse(pinsBytes.toString()),authority=pins.artifacts?.[product.identity.target];
 const material=inspectModuleNativeMaterials({module:'afs',target:product.identity.target,members:product.members,readMember:product.readMember,sourcePins:pinsBytes,nativePolicySource:source.readTracked('scripts/agentfs-native-ci/accept.py')});
 need(/^[a-f0-9]{40}$/u.test(pins.source)&&String(Number(pins.run))===String(pins.run)&&Number.isSafeInteger(Number(pins.run))&&Number(pins.run)>0&&authority&&String(Number(authority.id))===String(authority.id)&&Number.isSafeInteger(Number(authority.id))&&Number(authority.id)>0&&/^[a-f0-9]{64}$/u.test(authority.zip)&&material.nativeSourceSha===pins.source,'immutable native authority tuple required');
 const originals:{name:string;data:Buffer}[]=[],deadline=performance.now()+30000;
 const read=async(name:string,endpoint:string)=>{
  const remaining=deadline-performance.now();need(remaining>0,'metadata deadline expired');
  const headers:Record<string,string>={Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};if(input.token)headers.Authorization='Bearer '+input.token;
  const response=await fetch('https://api.github.com/repos/undefinedsco/xpod/'+endpoint,{headers,redirect:'error',signal:AbortSignal.timeout(Math.max(1,Math.floor(remaining)))});
  need(response.status===200&&response.body&&!response.redirected,'fixed metadata response unavailable');
  if(!response.body)throw Error('AFS native acquisition: missing metadata body');
  const reader=response.body.getReader(),chunks:Buffer[]=[];let bytes=0;
  try{for(;;){need(performance.now()<deadline,'metadata deadline expired');const row=await reader.read();if(row.done)break;bytes+=row.value.length;need(bytes<=1024**2,'metadata byte bound');chunks.push(Buffer.from(row.value));}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const data=Buffer.concat(chunks);originals.push({name,data});return JSON.parse(data.toString());
 };
 const run=await read('afs-native-run-locator.original.json','actions/runs/'+pins.run);
 const artifact=await read('afs-native-artifact-locator.original.json','actions/artifacts/'+authority.id);
 need(run.id===Number(pins.run)&&Number.isSafeInteger(run.run_attempt)&&run.run_attempt>0&&run.status==='completed'&&run.conclusion==='success'&&run.repository?.full_name==='undefinedsco/xpod'&&run.head_repository?.full_name==='undefinedsco/xpod'&&/^[a-f0-9]{40}$/u.test(run.head_sha)&&run.path?.split('@')[0]==='.github/workflows/agentfs-native-acceptance.yml','actual successful native run required');
 need(artifact.id===Number(authority.id)&&artifact.workflow_run?.id===run.id&&artifact.workflow_run?.head_sha===run.head_sha&&artifact.name===`agentfs-native-${product.identity.target}-${pins.source}`&&artifact.expired===false&&artifact.digest==='sha256:'+authority.zip,'artifact differs from immutable native authority');
 assertDerivedSourceCurrent(input.source);need(collectedArtifactView(input.artifact)===product&&derivedSourceView(input.source)===source,'product/source custody changed');
 // Metadata is evidence only, never a restored origin/native capability.
 need(performance.now()<deadline,'metadata deadline expired');
 return Object.freeze({coordinates:Object.freeze({schemaVersion:1,sourceSha:pins.source,runHeadSha:run.head_sha,runId:run.id,runAttempt:run.run_attempt,artifactId:artifact.id,artifactSha256:authority.zip}),target:product.identity.target,metadataOriginals:Object.freeze(originals.map(row=>Object.freeze(row)))});
}
