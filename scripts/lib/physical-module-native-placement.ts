/** Controlled producer byte substitutions, not a native/source admission token.
 * One hook runs while package inventories are formed, before bins/provenance
 * are sealed. Root dependency trees are always read-only. */
import {createHash} from 'node:crypto';
import {closeSync,constants,fstatSync,lstatSync,mkdirSync,openSync,readSync,realpathSync,writeFileSync,writeSync,fchmodSync} from 'node:fs';
import type {Stats} from 'node:fs';
import path from 'node:path';
import limits from './module-artifact-limits.json';
export interface PhysicalNativePlacement {
 readonly sourceKind:string;readonly target:string;
 readonly placements:readonly Readonly<{source:string;destination:string;bytes:number;sha256:string;mode:number}>[];
 readonly indexDestination:string;readonly index:Readonly<Record<string,unknown>>;
 assertCurrent():void;
}
const safe=(name:string)=>Boolean(name)&&!path.isAbsolute(name)&&!/[\\\u0000-\u001f\u007f]/u.test(name)&&name.split('/').every(part=>part&&part!=='.'&&part!=='..');
function need(value:unknown,why:string):asserts value {if(!value)throw Error('Physical native placement: '+why);}
const identity=(s:Stats)=>[s.dev,s.ino,s.size,s.mode,s.nlink,s.mtimeMs,s.ctimeMs].join(':');
function regular(file:string){let current=path.parse(file).root;for(const part of file.slice(current.length).split(path.sep)){current=path.join(current,part);need(!lstatSync(current).isSymbolicLink(),'source/destination symlink');}const s=lstatSync(file);need(s.isFile()&&s.nlink===1,'single regular original required');return s;}
export function preparePhysicalNativePlacements(stage:string,batches:readonly PhysicalNativePlacement[]=[]){
 need(batches.length<=16,'bounded placement groups');
 const substitutions=new Map<string,{batch:PhysicalNativePlacement;file:PhysicalNativePlacement['placements'][number];identity:string}>(),consumed=new Set<string>(),indexes=new Set<string>();let total=0;
 for(const batch of batches){
  need(typeof batch.assertCurrent==='function'&&/^[a-z][a-z0-9-]+$/u.test(batch.sourceKind)&&batch.target===process.platform+'-'+process.arch,'explicit matching-host producer placement');batch.assertCurrent();
  need(/^provenance\/native\/[a-z][a-z0-9-]*\/index\.json$/u.test(batch.indexDestination)&&!indexes.has(batch.indexDestination),'unique fixed native index destination');indexes.add(batch.indexDestination);
  need(batch.index.schemaVersion===2&&batch.index.sourceKind===batch.sourceKind&&batch.index.target===batch.target&&JSON.stringify(batch.index).length<=limits.metadataBytes,'bound producer index');
  need(batch.placements.length>0&&batch.placements.length<=16,'bounded nonempty actual placements');
  for(const file of batch.placements){
   need(safe(file.destination)&&/^node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+\/bin\/[^/]+$/u.test(file.destination)&&!substitutions.has(file.destination),'declared package bin/terms destination');
   need(path.isAbsolute(file.source)&&realpathSync(file.source)===file.source&&!file.source.startsWith(path.resolve(stage)+path.sep),'canonical external product original');
   need(Number.isSafeInteger(file.bytes)&&file.bytes>0&&file.bytes<=limits.shardBytes&&/^[a-f0-9]{64}$/u.test(file.sha256)&&[0o644,0o755].includes(file.mode),'bounded actual product ref');
   need(Object.values(batch.index).filter(value=>value&&typeof value==='object'&&(value as any).path===file.destination&&(value as any).bytes===file.bytes&&(value as any).sha256===file.sha256).length===1,'index must bind each actual placed product');
   const s=regular(file.source);need(s.size===file.bytes,'actual product size differs');total+=file.bytes;need(total<=limits.packedBytes,'shared staged native byte bound');substitutions.set(file.destination,{batch,file,identity:identity(s)});
  }
 }
 function copy(relative:string,destination:string):Readonly<{bytes:number;sha256:string;mode:number}>|undefined{
  const bound=substitutions.get(relative);if(!bound)return undefined;
  need(!consumed.has(relative)&&path.resolve(destination)===path.resolve(stage,relative),'one declared package-copy destination');bound.batch.assertCurrent();
  const before=regular(bound.file.source);need(identity(before)===bound.identity,'original changed before placement');
  let current=path.resolve(stage);for(const part of relative.split('/').slice(0,-1)){current=path.join(current,part);try{need(lstatSync(current).isDirectory()&&!lstatSync(current).isSymbolicLink(),'unsafe stage ancestor');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;mkdirSync(current);}}
  const input=openSync(bound.file.source,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let output:number|undefined;
  try{output=openSync(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);need(identity(fstatSync(input))===bound.identity,'same original FD');const chunk=Buffer.alloc(limits.rangeBytes),digest=createHash('sha256');let bytes=0;
   for(;;){const count=readSync(input,chunk,0,chunk.length,null);if(!count)break;bytes+=count;need(bytes<=bound.file.bytes,'original grew during placement');digest.update(chunk.subarray(0,count));let at=0;while(at<count)at+=writeSync(output,chunk,at,count-at);}
   need(bytes===bound.file.bytes&&digest.digest('hex')===bound.file.sha256&&identity(fstatSync(input))===bound.identity&&identity(regular(bound.file.source))===bound.identity,'same original full bytes changed');fchmodSync(output,bound.file.mode);
  }finally{closeSync(input);if(output!==undefined)closeSync(output);}
  bound.batch.assertCurrent();consumed.add(relative);return Object.freeze({bytes:bound.file.bytes,sha256:bound.file.sha256,mode:bound.file.mode});
 }
 function finalize(){
  need(consumed.size===substitutions.size,'declared native replacement not reached by physical package copy');
  for(const [relative,bound] of substitutions){
   const file=path.resolve(stage,relative),before=regular(file);need(before.size===bound.file.bytes&&(before.mode&0o777)===bound.file.mode,'placed product metadata changed');
   const fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));try{const digest=createHash('sha256'),block=Buffer.alloc(limits.rangeBytes);let count=0;for(;;){const n=readSync(fd,block,0,block.length,null);if(!n)break;count+=n;need(count<=bound.file.bytes,'placed product grew');digest.update(block.subarray(0,n));}need(count===bound.file.bytes&&digest.digest('hex')===bound.file.sha256&&identity(fstatSync(fd))===identity(before)&&identity(regular(file))===identity(before),'placed product bytes changed before seal');}finally{closeSync(fd);}
  }
  for(const batch of batches){batch.assertCurrent();let current=path.resolve(stage);for(const part of batch.indexDestination.split('/').slice(0,-1)){current=path.join(current,part);try{const s=lstatSync(current);need(s.isDirectory()&&!s.isSymbolicLink(),'unsafe native index parent');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;mkdirSync(current);}}writeFileSync(path.join(stage,batch.indexDestination),JSON.stringify(batch.index,null,2)+'\n',{flag:'wx',mode:0o444});}
 }
 return Object.freeze({copy,finalize});
}
