import path from 'node:path';
import {createRequire} from 'node:module';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
const {readCopyLedger}=createRequire(import.meta.url)('../../service-pack-copy-ledger.cjs') as {readCopyLedger(raw:Buffer,check:()=>void):any[]};
const {inspectTarballStream}=createRequire(import.meta.url)('../../workspace-package-payload.cjs') as {inspectTarballStream(source:Readable,limits:unknown,signal?:AbortSignal):Promise<any>};
function need(value:unknown,why:string):asserts value{if(!value)throw Error('Service pack copied payload: '+why);}
/** The single parser checks actual source tar payloads against same-call copied
 * bytes. This proves the selected snapshot, not official registry/Git origin. */
export async function inspectServicePackCopiedPayloads(input:{collection:any;readBody(reference:any):Promise<Buffer>;remaining:{expandedBytes:number;members:number};readObject?(reference:any):Buffer;check():void;signal?:AbortSignal}){
 const {collection}=input;need(['actual-service-pack-input-custody-v1','actual-service-pack-input-custody-v2'].includes(collection?.details?.inputCustodyModel)&&Array.isArray(collection.records)&&collection.records.length<=512,'bounded same-call copy model');
 let verified=0;const used=new Set<number>();
 for(const body of collection.records){
  if(body.kind!=='actual-pack-body'||body.role!=='selected-input-source-tar')continue;
  const raw=await input.readBody(body.reference);input.check();need(Buffer.isBuffer(raw)&&raw.length===body.reference.bytes&&createHash('sha256').update(raw).digest('hex')===body.reference.sha256,'complete actual retained source archive');
  const parsed=await inspectTarballStream(Readable.from((function*(){for(let at=0;at<raw.length;at+=65536){input.check();yield raw.subarray(at,at+65536);}})()),{expandedBytes:input.remaining.expandedBytes,members:input.remaining.members,manifestBytes:131072,memberDigests:true,memberMetadataBytes:4*1024*1024},input.signal);
  verifyServicePackCopiedMembers({collection,body,members:parsed.memberDigests,used,readObject:input.readObject,check:input.check});input.remaining.expandedBytes-=parsed.expandedBytes;input.remaining.members-=parsed.members;verified++;
 }
 need(verified>0,'actual selected source bodies required');collection.records.forEach((row:any,index:number)=>{if(['actual-selected-input-copy','actual-selected-input-copy-ledger'].includes(row.role))need(used.has(index),'every actual selected copy is retained in a source body');});return Object.freeze({selectedInputSnapshotPayloadVerified:true as const,verified,officialRegistrySourceVerified:false as const,immutableGitSourceVerified:false as const});
}

export function verifyServicePackCopiedMembers(input:{collection:any;body:any;members:any[];used:Set<number>;readObject?(reference:any):Buffer;check():void}){
 const {collection,body,used}=input;need(['actual-service-pack-input-custody-v1','actual-service-pack-input-custody-v2'].includes(collection?.details?.inputCustodyModel)&&Array.isArray(collection.records)&&collection.records.length<=512,'bounded same-call copy model');
  input.check();need(typeof body.destinationRoot==='string'&&path.posix.isAbsolute(body.destinationRoot)&&body.copiedRecords&&Number.isSafeInteger(body.copiedRecords.first)&&Number.isSafeInteger(body.copiedRecords.last)&&body.copiedRecords.first>=0&&body.copiedRecords.last>=body.copiedRecords.first&&body.copiedRecords.last<collection.records.length,'exact selected copy record interval');
  const expected=new Map<string,any>();
  const add=(row:any)=>{
   const directory=row.kind==='actual-pack-input-directory-copy-v1';need(directory||row.kind==='actual-pack-input-copy-v1','fixed copied member original');
   const destination=directory?row.destination:row.destination.path,relative=path.posix.relative(body.destinationRoot,destination);need(relative===''||(!relative.startsWith('../')&&!path.posix.isAbsolute(relative)&&!relative.split('/').some((part:string)=>part===''||part==='.'||part==='..')),'copied member stays in selected root');
   const name='package'+(relative?'/'+relative:'')+(directory?'/':'');need(!expected.has(name),'unique copied member');
   expected.set(name,{path:name,type:directory?'directory':'file',mode:directory?row.mode:Number(BigInt(row.destination.identity[2])&0o7777n),bytes:directory?0:row.bytes,...(directory?{}:{sha256:row.sha256})});
  };
  for(let index=body.copiedRecords.first;index<=body.copiedRecords.last;index++){
   input.check();need(!used.has(index),'copy input used by multiple bodies');used.add(index);const record=collection.records[index];need(record.kind==='actual-resolution-event','complete actual copy event');if(record.role==='actual-selected-input-copy-ledger'){need(input.readObject,'actual copy ledger reader required');const raw=input.readObject(record.reference);need(raw.length===record.reference.bytes&&createHash('sha256').update(raw).digest('hex')===record.reference.sha256,'same retained copy ledger');for(const row of readCopyLedger(raw,input.check))if(row.kind!=='actual-pack-input-directory-begin-v1')add(row);continue;}need(record.role==='actual-selected-input-copy','complete contiguous actual copy records');const row=record.observation;
   if(row.kind==='actual-pack-input-directory-begin-v1')continue;
   add(row);
  }
  need(expected.size>0,'nonempty copied member closure');
 need(Array.isArray(input.members)&&input.members.length===expected.size,'actual source archive has exact copied member closure');
 for(const row of input.members){input.check();const member=expected.get(row.path);need(member&&JSON.stringify(member)===JSON.stringify(row),'actual source archive member differs from selected copy');expected.delete(row.path);}
 need(expected.size===0,'all actual copied members retained');
}
