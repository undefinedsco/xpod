import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import limits from '../module-artifact-limits.json';
import scope from '../service-workspace-build-scope.json';
import {inspectCandidateVersionedManifestMutation} from './candidate-service-root-mutation';
const sha=(raw:Buffer)=>createHash('sha256').update(raw).digest('hex');
function need(value:unknown,reason:string):asserts value{if(!value)throw Error('Service workspace build: '+reason);}
type FileRow=readonly [string,readonly string[],string];
const excluded=['.git','.test-data','__pycache__','dist','local','logs','node_modules'];
const model='actual-service-build-file-snapshots-v2';
function list(value:unknown,layout:boolean):readonly string[]{
 need(Array.isArray(value)&&value.length>0&&value.every(item=>typeof item==='string'&&item.length>0&&!item.includes('\\')
  &&(layout?item.split('/').every(part=>part&&part!=='.'&&part!=='..')&&!item.startsWith('/'):!item.includes('/')&&item!=='.'&&item!=='..')),'declared generated scope');
 need(new Set(value).size===value.length,'duplicate declared generated scope');return value as string[];
}
/** Position 5 is `st_ctime_ns`, which metadata operations can advance without
 * changing the recorded contents. Keep it in the snapshots and in the producer's
 * full identity checks during each held-FD read. Across the build, compare all
 * other identity fields and byte hashes. This binds the recorded snapshots;
 * it does not prove the absence of writes between samples or compiler authority. */
const CTIME_INDEX=5;
const contentIdentity=(row:FileRow):readonly string[]=>row[1].filter((_,index)=>index!==CTIME_INDEX);
function sameBuildSource(before:readonly FileRow[],after:readonly FileRow[]):boolean{
 return before.length===after.length&&before.every((row,index)=>{
  const next=after[index];
  return next!==undefined&&row[0]===next[0]&&row[2]===next[2]&&isDeepStrictEqual(contentIdentity(row),contentIdentity(next));
 });
}
const generatedNames=list(scope.generatedDirectoryNames,false);
const generatedRoots=(list(scope.generatedDirectoryRoots,true) as string[]).map(root=>root.split('/'));
const isGenerated=(parts:readonly string[])=>generatedNames.some(name=>parts.includes(name))||generatedRoots.some(root=>root.every((part,index)=>parts[index]===part));
function parse(raw:Buffer,generated:boolean):readonly FileRow[]{
 need(Buffer.isBuffer(raw)&&raw.length>0&&raw.length<=limits.metadataBytes,'bounded actual build snapshot');const text=raw.toString('utf8');need(Buffer.from(text).equals(raw),'actual UTF-8 build snapshot');const value=JSON.parse(text);
 need(value?.schemaVersion===1&&value.kind===model&&value.generated===generated&&value.authorityVerified===false&&isDeepStrictEqual(value.excludedDirectoryNames,excluded)&&isDeepStrictEqual(value.generatedDirectoryNames,generatedNames)&&isDeepStrictEqual(value.generatedDirectoryRoots,generatedRoots.map(root=>root.join('/')))&&Array.isArray(value.rows)&&value.rows.length<=limits.members,'explicit same build snapshot model');
 const seen=new Set<string>();let total=0;
 for(const row of value.rows){need(Array.isArray(row)&&row.length===3&&typeof row[0]==='string'&&row[0].length<=4096&&!/[\u0000-\u001f\u007f\\]/u.test(row[0])&&!row[0].startsWith('/')&&!row[0].split('/').some((part:string)=>!part||part==='.'||part==='..')&&!seen.has(row[0]),'unique actual build relative file');seen.add(row[0]);need(Array.isArray(row[1])&&row[1].length===7&&row[1].every((v:unknown)=>typeof v==='string'&&v.length<=20&&/^(0|[1-9][0-9]*)$/u.test(v)&&BigInt(v)<=0xffffffffffffffffn)&&(BigInt(row[1][2])&0o170000n)===0o100000n&&row[1][6]==='1'&&BigInt(row[1][3])<=BigInt(limits.shardBytes)&&typeof row[2]==='string'&&/^[a-f0-9]{64}$/u.test(row[2]),'full regular held build identity/hash');need(isGenerated(row[0].split('/'))===generated,'declared generated/source snapshot partition');total+=Number(row[1][3]);need(total<=limits.sourceMaterialBytes,'same observed build read bound');}
 need(Number.isSafeInteger(value.observedFileBytes)&&value.observedFileBytes===total,'actual build file byte total');return value.rows;
}
/** Same strict original snapshot parser, normalized for controlled replay.
 * The caller must obtain the bytes through the genuine pack observation. */
export function inspectServiceWorkspaceOutputSnapshot(raw:Buffer){
 return Object.freeze(parse(raw,true).map(([path,identity,sha256])=>Object.freeze({path,bytes:Number(identity[3]),sha256,mode:Number(BigInt(identity[2])&0o777n)})));
}
/** A version-stamped manifest the release step legitimately rewrites
 * (`--apply-root-version` writes the root AND `desktop/package.json`). Each entry
 * carries the RECORDED before/after originals plus the immutable Git bytes, and is
 * admitted only after the shared transition verifier proves the bytes equal
 * `immutable` + the run-derived candidate version. Nothing arbitrary is accepted. */
export type VerifiedVersionedManifest=Readonly<{relative:string;before:Buffer;after:Buffer;immutable:Buffer;name:string;run:any;sourceSha:string;runId:number;runAttempt:number;expectedVersion?:string}>;
/** The ONLY version-stamped manifest the release step may rewrite besides the
 * root. `--apply-root-version` writes both `package.json` (verified by the
 * dedicated root-mutation proof) and this sibling, so only this exact
 * path/namespace pair may receive recorded-after bytes. Any other manifest keeps
 * strict immutable-Git binding. */
export const DESKTOP_VERSIONED_MANIFEST=Object.freeze({relative:'desktop/package.json',name:'@undefineds.co/xpod-desktop'});
export type VersionedManifestDescriptor=Readonly<{path:string;bytes:number;sha256:string}>;
export type VersionedManifestSource=Readonly<{
 /** retained closed-set reader for one recorded original descriptor */
 readOriginal(descriptor:VersionedManifestDescriptor,maximum:number):Buffer;
 /** immutable committed Git bytes for a relative path, exact length */
 readImmutableGit(relative:string,exact:number):Readonly<{mode:string;bytes:Buffer}>;
 /** the authentic same-run original (already parsed and bounded by the caller) */
 run:any;sourceSha:string;runId:number;runAttempt:number;
 /** the version already proven by the root mutation proof */
 expectedVersion:string;
}>;
/** Production data-plumbing adapter. It reads the two RECORDED desktop originals
 * from the same issued closed set, reads the immutable Git bytes, and constructs
 * the verified transition itself. It never accepts caller-supplied after-bytes. */
export function resolveDesktopVersionedManifest(source:VersionedManifestSource,
 master:any):Readonly<{relative:string;before:Buffer;after:Buffer;immutable:Buffer;name:string;run:any;sourceSha:string;runId:number;runAttempt:number;expectedVersion:string}>{
 const originals=master?.sourceOriginals;
 need(originals&&typeof originals==='object','master source originals required');
 const beforeRef=originals.desktopManifestBefore,afterRef=originals.desktopManifestAfter;
 const bounded=(ref:unknown,label:string):VersionedManifestDescriptor=>{
  const row=ref as any;
  need(row&&typeof row.path==='string'&&row.path.length>0&&Number.isSafeInteger(row.bytes)&&row.bytes>0
   &&row.bytes<=128*1024&&typeof row.sha256==='string'&&/^[a-f0-9]{64}$/u.test(row.sha256),'bounded recorded '+label+' descriptor');
  return Object.freeze({path:row.path,bytes:row.bytes,sha256:row.sha256});
 };
 const beforeDescriptor=bounded(beforeRef,'desktop before');
 const afterDescriptor=bounded(afterRef,'desktop after');
 need(beforeDescriptor.path!==afterDescriptor.path,'distinct recorded desktop originals required');
 const before=source.readOriginal(beforeDescriptor,128*1024);
 const after=source.readOriginal(afterDescriptor,128*1024);
 // The reader already bounds bytes; re-assert length AND hash so a reader that
 // returns wrong or foreign bytes cannot pass as a recorded original.
 need(before.length===beforeDescriptor.bytes&&sha(before)===beforeDescriptor.sha256,'recorded desktop before original bytes/hash');
 need(after.length===afterDescriptor.bytes&&sha(after)===afterDescriptor.sha256,'recorded desktop after original bytes/hash');
 need(!before.equals(after),'desktop transition must change bytes');
 const immutable=source.readImmutableGit(DESKTOP_VERSIONED_MANIFEST.relative,beforeDescriptor.bytes);
 return Object.freeze({relative:DESKTOP_VERSIONED_MANIFEST.relative,before,after,immutable:immutable.bytes,
  name:DESKTOP_VERSIONED_MANIFEST.name,run:source.run,sourceSha:source.sourceSha,
  runId:source.runId,runAttempt:source.runAttempt,expectedVersion:source.expectedVersion});
}
/** Called only after the genuine parent raw/receipt closed set is verified.
 * This binds snapshots and selected bytes; compiler/tool and dependency source
 * authority are separate obligations, never inferred from successful receipts. */
export function inspectServiceWorkspaceBuild(input:{before:Buffer;after:Buffer;outputs:Buffer;afterRoot:Buffer;versionedManifests?:readonly VerifiedVersionedManifest[];readGit:(relative:string,exact:number)=>Readonly<{mode:string;bytes:Buffer}>;selected:readonly {sourceRoot:string;inputKind?:string;members:readonly {path:string;bytes:number;sha256:string;mode:number}[]}[];check():void}){
 const before=parse(input.before,false),after=parse(input.after,false),outputs=parse(input.outputs,true);need(['package.json','bun.lock'].every(name=>before.some(row=>row[0]===name)),'actual root manifest and immutable lock build inputs required');need(sameBuildSource(before,after),'build source pre/post content or stable identities differ');
 // Only a genuinely version-stamped input may bind its recorded after bytes; every
 // other observed row is compared against immutable Git exactly as before. The
 // root manifest keeps its dedicated root-mutation proof at the caller.
 const stamped=new Map<string,Buffer>();
 for(const entry of input.versionedManifests??[]){
  input.check();
  // Only the reviewed desktop sibling may carry recorded-after bytes here; the
  // root has its own dedicated proof and every other manifest stays strict Git.
  need(entry.relative===DESKTOP_VERSIONED_MANIFEST.relative
   &&entry.name===DESKTOP_VERSIONED_MANIFEST.name,'unauthorized version-stamped manifest path/namespace');
  inspectCandidateVersionedManifestMutation(entry);
  need(!stamped.has(entry.relative),'duplicate version-stamped manifest');
  stamped.set(entry.relative,entry.after);
 }
 const present=new Set(before.map(row=>row[0]));
 // A recorded snapshot containing the version-stamped desktop manifest must be
 // given its recorded originals; there is no unverified fallback.
 if(present.has('desktop/package.json'))need(stamped.has('desktop/package.json'),'recorded desktop manifest transition originals required');
 for(const relative of stamped.keys())need(present.has(relative),'version-stamped manifest absent from recorded snapshot');
 for(const [relative,identity,digest] of before){input.check();const actual=relative==='package.json'?{mode:'100644',bytes:input.afterRoot}:stamped.has(relative)?{mode:'100644',bytes:stamped.get(relative)!}:input.readGit(relative,Number(identity[3]));need(actual.bytes.length===Number(identity[3])&&sha(actual.bytes)===digest&&(BigInt(identity[2])&0o777n)===BigInt('0o'+actual.mode.slice(-3)),'observed build input differs from immutable source');}
 const generated=new Map(outputs.map(row=>[row[0],row]));let trackedMembers=0,generatedMembers=0;
 for(const instance of input.selected){if(instance.inputKind!=='workspace')continue;need(/^\/app\/packages\/[^/]+$/u.test(instance.sourceRoot),'actual selected workspace root');for(const member of instance.members){input.check();need(member.path.startsWith('package/'),'selected workspace member root');const relative=instance.sourceRoot.slice(5)+'/'+member.path.slice(8),output=generated.get(relative);if(output){need(isGenerated(relative.split('/')),'only generated workspace files may be replaced by build payload');need(Number(output[1][3])===member.bytes&&output[2]===member.sha256&&Number(BigInt(output[1][2])&0o777n)===member.mode,'actual generated output differs from selected pack payload');generatedMembers++;}else{need(!isGenerated(relative.split('/')),'generated workspace output must exist in full output closure');const actual=input.readGit(relative,member.bytes);need(actual.bytes.length===member.bytes&&sha(actual.bytes)===member.sha256&&parseInt(actual.mode.slice(-3),8)===member.mode,'selected workspace source differs from immutable Git');trackedMembers++;}}}
 return Object.freeze({recordedBuildSourceSnapshotsMatchImmutableSource:true as const,selectedWorkspacePayloadSnapshotBound:true as const,trackedMembers,generatedMembers,workspaceTransformVerified:false as const,pending:Object.freeze(['service-build-compiler-and-dependency-input-origin-unverified'])});
}
