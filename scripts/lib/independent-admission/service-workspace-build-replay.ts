import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import limits from '../module-artifact-limits.json';
import scope from '../service-workspace-build-scope.json';
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
/** Called only after the genuine parent raw/receipt closed set is verified.
 * This binds snapshots and selected bytes; compiler/tool and dependency source
 * authority are separate obligations, never inferred from successful receipts.
 */
export function inspectServiceWorkspaceBuild(input:{before:Buffer;after:Buffer;outputs:Buffer;afterRoot:Buffer;readGit:(relative:string,exact:number)=>Readonly<{mode:string;bytes:Buffer}>;selected:readonly {sourceRoot:string;inputKind?:string;members:readonly {path:string;bytes:number;sha256:string;mode:number}[]}[];check():void}){
 const before=parse(input.before,false),after=parse(input.after,false),outputs=parse(input.outputs,true);need(['package.json','bun.lock'].every(name=>before.some(row=>row[0]===name)),'actual root manifest and immutable lock build inputs required');need(isDeepStrictEqual(before,after),'build source pre/post full identities or bytes differ');
 for(const [relative,identity,digest] of before){input.check();const actual=relative==='package.json'?{mode:'100644',bytes:input.afterRoot}:input.readGit(relative,Number(identity[3]));need(actual.bytes.length===Number(identity[3])&&sha(actual.bytes)===digest&&(BigInt(identity[2])&0o777n)===BigInt('0o'+actual.mode.slice(-3)),'observed build input differs from immutable source');}
 const generated=new Map(outputs.map(row=>[row[0],row]));let trackedMembers=0,generatedMembers=0;
 for(const instance of input.selected){if(instance.inputKind!=='workspace')continue;need(/^\/app\/packages\/[^/]+$/u.test(instance.sourceRoot),'actual selected workspace root');for(const member of instance.members){input.check();need(member.path.startsWith('package/'),'selected workspace member root');const relative=instance.sourceRoot.slice(5)+'/'+member.path.slice(8),output=generated.get(relative);if(output){need(isGenerated(relative.split('/')),'only generated workspace files may be replaced by build payload');need(Number(output[1][3])===member.bytes&&output[2]===member.sha256&&Number(BigInt(output[1][2])&0o777n)===member.mode,'actual generated output differs from selected pack payload');generatedMembers++;}else{need(!isGenerated(relative.split('/')),'generated workspace output must exist in full output closure');const actual=input.readGit(relative,member.bytes);need(actual.bytes.length===member.bytes&&sha(actual.bytes)===member.sha256&&parseInt(actual.mode.slice(-3),8)===member.mode,'selected workspace source differs from immutable Git');trackedMembers++;}}}
 return Object.freeze({recordedBuildSourceSnapshotsMatchImmutableSource:true as const,selectedWorkspacePayloadSnapshotBound:true as const,trackedMembers,generatedMembers,workspaceTransformVerified:false as const,pending:Object.freeze(['service-build-compiler-and-dependency-input-origin-unverified'])});
}
