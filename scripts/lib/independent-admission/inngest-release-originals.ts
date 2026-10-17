import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {performance} from 'node:perf_hooks';
import {mkdirSync,mkdtempSync,writeFileSync,statfsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {modulePackageName} from '../../../packages/xpod-cli/src/module-catalog';
import pins from '../../../packages/xpod-api/scripts/inngest-input-pins.json';
import {collectedArtifactView} from './artifact-collector';
import {derivedSourceView,assertDerivedSourceCurrent} from './source-context';
import {collectedProductOriginal} from './product-original';
import type {CollectedArtifactIdentity} from './artifact-contract';
import {assertLegalFileIdentity,type LegalFileIdentity} from './legal-file-custody';
import {inspectModuleNativeMaterials} from './native-module-materials';
import {readSignatureOriginal} from './qlever-signature-original-custody';
import {inspectInngestReleaseTar} from './inngest-release-tar';
type Ref=Readonly<{path:string;bytes:number;sha256:string}>;
export interface OfficialInngestReleaseView {
 readonly identity:CollectedArtifactIdentity; readonly target:string; readonly sourceCommit:string; readonly releaseID:number; readonly releaseTag:string;
 readonly archive:Ref; readonly sourceArchive:Ref; readonly binary:Ref; readonly license:Ref;
 readonly officialOriginVerified:true; readonly releaseMembersVerified:true;
 readonly sourceArchiveScope:'reviewed-fixed-commit-archive-digest-and-collected-full-bytes';
 readonly metadataOriginals:readonly Ref[]; readonly retainedDirectory:string;
 readMetadataOriginal(name:string):Buffer; assertCurrent():void;
}
const issued=new WeakMap<object,OfficialInngestReleaseView>();
const observations=new WeakMap<object,{source:unknown;promise:Promise<object>}>();
function need(value:unknown,reason:string):asserts value {if(!value)throw Error('Official Inngest release: '+reason);}
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const PINS_SHA='d5d2225c7c8cf1bc1fc27f11d3bfc4f13c5dd597dae3c65701b0f4c6a200e567';
export function officialInngestReleaseView(capability:unknown):OfficialInngestReleaseView|undefined {
 const view=capability&&typeof capability==='object'?issued.get(capability):undefined;view?.assertCurrent();return view;
}
/** Canonical product identity mechanics only; does not issue authority. */
export function isInngestApiProductIdentity(identity:Pick<CollectedArtifactIdentity,'package'|'target'>):boolean {
 const target=identity.target;
 if(!target||!Object.prototype.hasOwnProperty.call(pins.assets,target))return false;
 const [platform,arch]=target.split('-');
 return identity.package===modulePackageName('api',platform,arch);
}
/** Pure metadata mechanics only; never registers a capability. */
export function verifyInngestOfficialMetadata(release:Record<string,unknown>,tag:Record<string,unknown>,target:string):void {
 need(Object.prototype.hasOwnProperty.call(pins.assets,target),'fixed target required');
 const asset=pins.assets[target as keyof typeof pins.assets];
 need(release.id===pins.releaseID&&release.tag_name==='v1.40.0'&&release.draft===false&&release.prerelease===false&&release.html_url==='https://github.com/inngest/inngest/releases/tag/v1.40.0','official release tuple');
 const object=tag.object as Record<string,unknown>|undefined;need(tag.ref==='refs/tags/v1.40.0'&&object?.type==='commit'&&object.sha===pins.sourceCommit,'official tag/commit tuple');
 const matches=Array.isArray(release.assets)?release.assets.filter((row:Record<string,unknown>)=>row.name===asset.name):[];
 need(matches.length===1&&Object.entries(asset).every(([key,value])=>matches[0][key]===value)&&matches[0].browser_download_url===`https://github.com/inngest/inngest/releases/download/v1.40.0/${asset.name}`,'official asset tuple/full digest');
}
/** The sole official-release issuer. Caller JSON and arbitrary transport/readers
 * cannot register facts. Metadata GETs are independent of embedded producer JSON.
 * Release asset digest comes from that official GET; source tar scope is the
 * separately reviewed commit/digest pin, not a claimed independent tar download. */
export function observeOfficialInngestRelease(input:{artifact:unknown;source:unknown;remainingMilliseconds?:number}):Promise<object> {
 if(input.remainingMilliseconds!==undefined&&(!Number.isFinite(input.remainingMilliseconds)||input.remainingMilliseconds<1))return Promise.reject(Error('Official Inngest release: deadline expired'));
 const artifact=collectedArtifactView(input.artifact),source=derivedSourceView(input.source);
 if(!artifact||!source||!input.artifact||typeof input.artifact!=='object')return Promise.reject(Error('Official Inngest release: actual product/source capabilities required'));
 const prior=observations.get(input.artifact);if(prior){if(prior.source!==input.source)return Promise.reject(Error('Official Inngest release: exact source handle required'));return prior.promise.then(cap=>{const view=officialInngestReleaseView(cap);need(view&&derivedSourceView(input.source)===source&&source.sourceSha===view.identity.sourceSha,'cached exact source binding');assertDerivedSourceCurrent(input.source);return cap;});}
 const promise=observe(input,artifact,source);observations.set(input.artifact,{source:input.source,promise});return promise;
}
async function observe(input:{artifact:unknown;source:unknown;remainingMilliseconds?:number},artifact:NonNullable<ReturnType<typeof collectedArtifactView>>,source:NonNullable<ReturnType<typeof derivedSourceView>>) {
 const remaining=input.remainingMilliseconds??120000;need(Number.isFinite(remaining)&&remaining>=1,'deadline expired');const deadline=performance.now()+Math.min(remaining,120000);
 const check=()=>need(performance.now()<deadline,'shared observation deadline expired');
 const custody=()=>{need(collectedArtifactView(input.artifact)===artifact&&derivedSourceView(input.source)===source,'product/source custody revoked');assertDerivedSourceCurrent(input.source);};
 need(isInngestApiProductIdentity(artifact.identity)&&artifact.identity.sourceSha===source.sourceSha,'exact API product/source required');
 const target=artifact.identity.target;need(target&&Object.prototype.hasOwnProperty.call(pins.assets,target),'fixed target required');
 const pinBytes=source.readTracked('packages/xpod-api/scripts/inngest-input-pins.json');need(sha(pinBytes)===PINS_SHA&&isDeepStrictEqual(JSON.parse(pinBytes.toString()),pins),'reviewed immutable Git pins differ');
 custody();check();const material=inspectModuleNativeMaterials({module:'api',target,members:artifact.members,readMember:artifact.readMember,sourcePins:pinBytes});
 const reference=(name:string):Ref=>{const row=artifact.members.find(row=>row.path===name);need(row,'registered product original required');return Object.freeze({path:row.path,bytes:row.bytes,sha256:row.sha256});};
 need('archive' in material,'API release archive profile required');
 const archive=reference(material.archive.path),sourceArchive=reference(material.sourceArchive.path),binary=reference(material.binary.path),license=reference('node_modules/inngest-cli/bin/LICENSE.md');
 need(binary.bytes>0&&binary.bytes<=192*1024**2&&license.bytes>0&&license.bytes<=1024**2&&archive.bytes+sourceArchive.bytes+binary.bytes+license.bytes<=320*1024**2,'native original aggregate/member byte bound');
 const bound=(ref:Ref)=>collectedProductOriginal(input.artifact,{path:ref.path,sizeBytes:ref.bytes,sha256:ref.sha256});
 const originals=[archive,sourceArchive,binary,license].map(ref=>({ref,reader:bound(ref)}));
 for(const {ref,reader}of originals){check();const digest=createHash('sha256');for(let at=0;at<ref.bytes;at+=65536){check();const count=Math.min(65536,ref.bytes-at),bytes=reader.readRange(at,count);need(bytes.length===count,'truncated actual member');digest.update(bytes);}need(digest.digest('hex')===ref.sha256,'actual original full hash differs');}
 const asset=pins.assets[target as keyof typeof pins.assets];need(archive.bytes===asset.size&&archive.sha256===asset.digest.slice(7)&&sourceArchive.bytes===pins.sourceArchive.bytes&&sourceArchive.sha256===pins.sourceArchive.sha256,'full original pin binding');
 const rows=await inspectInngestReleaseTar({bytes:archive.bytes,readRange:originals[0].reader.readRange},check);
 for(const [name,ref]of [['inngest',binary],['LICENSE.md',license]] as const){const row=rows.find(row=>row.path===name);need(row&&row.bytes===ref.bytes&&row.sha256===ref.sha256,'release member differs from actual packaged bytes');}
 const root=fileURLToPath(new URL('../../../.test-data/inngest-official-release/',import.meta.url));mkdirSync(root,{recursive:true});const free=statfsSync(root,{bigint:true});need(free.bavail*free.bsize>=1024n**3n+1024n**2n,'free-space floor');const directory=mkdtempSync(path.join(root,'observed-'));
 const guards:LegalFileIdentity[]=[],metadata=new Map<string,Buffer>(),refs:Ref[]=[];let total=0;
 async function get(name:string,url:string){check();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.min(15000,Math.max(1,deadline-performance.now())));const chunks:Buffer[]=[];let bytes=0;
  try {const response=await fetch(url,{redirect:'error',signal:controller.signal,headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'xpod-independent-origin'}});need(response.ok&&response.body&&new URL(response.url||url).origin==='https://api.github.com','official metadata response');const reader=response.body.getReader();try{for(;;){check();const next=await reader.read();if(next.done)break;bytes+=next.value.length;total+=next.value.length;need(bytes<=512*1024&&total<=1024*1024,'metadata aggregate bound');chunks.push(Buffer.from(next.value));}}finally{await reader.cancel().catch(()=>{});}}
  finally{clearTimeout(timer);}check();const data=Buffer.concat(chunks);const file=path.join(directory,name);writeFileSync(file,data,{flag:'wx',mode:0o444});guards.push(readSignatureOriginal(file,{bytes:data.length,sha256:sha(data)},512*1024,check).identity);metadata.set(name,data);refs.push(Object.freeze({path:name,bytes:data.length,sha256:sha(data)}));return JSON.parse(data.toString()) as Record<string,unknown>;
 }
 const api='https://api.github.com/repos/inngest/inngest';
 const release=await get('release.original.json',api+'/releases/362726265'),tag=await get('tag.original.json',api+'/git/ref/tags/v1.40.0');
 verifyInngestOfficialMetadata(release,tag,target);
 check();custody();for(const guard of guards)assertLegalFileIdentity(guard);
 const capability=Object.freeze({});const assertCurrent=()=>{custody();for(const guard of guards)assertLegalFileIdentity(guard);for(const {reader}of originals)reader.readRange(0,0);};
 const view:OfficialInngestReleaseView=Object.freeze({identity:artifact.identity,target,sourceCommit:pins.sourceCommit,releaseID:pins.releaseID,releaseTag:'v1.40.0',archive,sourceArchive,binary,license,officialOriginVerified:true,releaseMembersVerified:true,sourceArchiveScope:'reviewed-fixed-commit-archive-digest-and-collected-full-bytes',metadataOriginals:Object.freeze(refs),retainedDirectory:directory,readMetadataOriginal(name:string){assertCurrent();const bytes=metadata.get(name);need(bytes,'registered metadata required');return Buffer.from(bytes);},assertCurrent});
 issued.set(capability,view);return capability;
}
