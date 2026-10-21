/** Retained byte protocol fixture, never an issuer. */
import {createHash} from 'node:crypto';
export const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex'),raw=(v:unknown)=>Buffer.from(JSON.stringify(v));
const roles=['pull','create','inspect','copy','remove','confirm-absent'];
export function tar(name:string,body:Buffer,type='0',mode=0o644){
 const header=Buffer.alloc(512);if(Buffer.byteLength(name)>100){const at=name.lastIndexOf('/');if(at<0||Buffer.byteLength(name.slice(0,at))>155||Buffer.byteLength(name.slice(at+1))>100)throw Error('fixture ustar path too long');header.write(name.slice(at+1),0,100);header.write(name.slice(0,at),345,155);}else header.write(name,0,100);header.write(mode.toString(8).padStart(7,'0')+'\0',100);header.write('0000000\0',108);header.write('0000000\0',116);header.write(body.length.toString(8).padStart(11,'0')+'\0',124);header.fill(32,148,156);header.write(type,156);header.write('ustar\0',257);let checksum=0;for(const b of header)checksum+=b;header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148);return Buffer.concat([header,body,Buffer.alloc((512-body.length%512)%512),Buffer.alloc(1024)]);
}
export function fixture(options:{sourceSha?:string;version?:string;descriptionBytes?:number}={}){
 const values=new Map<string,Buffer>();const ref=(path:string,body:Buffer)=>{values.set(path,body);return {path,bytes:body.length,sha256:sha(body)};};
 const image='ghcr.io/undefinedsco/xpod@sha256:'+'a'.repeat(64),config='sha256:'+'b'.repeat(64),cid='c'.repeat(64),nonce='d'.repeat(32),name='xpod-service-output-'+nonce,source='/checkout',controller=source+'/qlever/scripts/sdk-service-image-originals.py',sourceSha=options.sourceSha??'e'.repeat(40),version=options.version??'1.2.3-rc.8.1';
 // Sanitized image manifest deliberately differs from afterRoot; this leaf
 // proves only actual namespace/version plus same image/config and raw bytes.
 const body=raw({name:'@undefineds.co/xpod',version,...(options.descriptionBytes?{description:'X'.repeat(options.descriptionBytes)}:{})}),inspection={Id:cid,Image:config,Name:'/'+name,Config:{Image:image,Labels:{'xpod.service-output-owner':nonce}},State:{Running:false,Status:'created',Pid:0,StartedAt:'0001-01-01T00:00:00Z'}};
 const output={pull:Buffer.from('pulled'),create:Buffer.from(cid+'\n'),inspect:raw(inspection),copy:tar('package.json',body),remove:Buffer.from(cid+'\n'),'confirm-absent':Buffer.alloc(0)} as Record<string,Buffer>;
 const stages=roles.map((role,index)=>{
  const label='service-output-'+role,parent='stages/'+label+'/',stdout=ref(parent+'stdout.raw',output[role]!),stderr=ref(parent+'stderr.raw',Buffer.alloc(0)),supervisionRaw=ref('stages/'+label+'.raw.log',Buffer.alloc(0));
  const command=['/usr/bin/python3','-I','-S','-B',controller,'--source',source,'--source-sha',sourceSha,'--image-worker',role,'--service-image',image,'--container-name',name,'--owner-nonce',nonce,...(index>=2?['--container-id',cid]:[])];
  const receipt=ref(parent+'command.receipt.json',raw({schemaVersion:1,pid:12,pgid:11,command,exit:0,signal:null,actualWait:true,rawClosedBeforeHash:true,startedUnixNs:index*2000000+1,completedUnixNs:index*2000000+1000000,stdout:{...stdout,path:'stdout.raw'},stderr:{...stderr,path:'stderr.raw'}}));
  const supervisionReceipt=ref('stages/'+label+'.receipt.json',raw({command:['/usr/bin/python3','-B',source+'/qlever/scripts/sdk-command-materials.py','--exec-child','/tmp/service-image-originals/stages/'+label,JSON.stringify(command)],startedUTC:new Date(index*2).toISOString(),closedUTC:new Date(index*2+1).toISOString(),exit:0,signal:null,actualWait:true,rawClosedBeforeHash:true,ownedGroupAbsentAfterWait:true,pgid:11,resourceStop:false,supervisorError:null,cleanupErrors:[],rawSHA256:supervisionRaw.sha256}));return {name:label,receipt,stdout,stderr,supervisionReceipt,supervisionRaw,inputs:[],outputs:[]};
 });
 const master={stages:[{name:'service-source-head',receipt:ref('stages/service-source-head/command.receipt.json',raw({startedUnixNs:0}))}],sourcePath:source,controllerPath:controller,sourceSha,serviceImageReferenceByDigest:image,images:{service:{configDigest:config}},sourceOriginals:{serviceRootManifest:ref('output/service-root-package.original.json',body)},outputImageObservation:{schemaVersion:1,kind:'actual-stopped-service-image-root-manifest',imageReferenceByDigest:image,configDigest:config,containerId:cid,containerName:name,ownerNonce:nonce,stages}};
 const read=(reference:any,max:number)=>{const bytes=values.get(reference?.path);if(!bytes||bytes.length>max||bytes.length!==reference.bytes||sha(bytes)!==reference.sha256)throw Error('actual ref drift');return bytes;};
 const rewrite=(reference:any,value:any)=>{const bytes=Buffer.isBuffer(value)?value:raw(value);values.set(reference.path,bytes);reference.bytes=bytes.length;reference.sha256=sha(bytes);
  // Rebind command raw hashes too: negatives reach the semantic check, rather
  // than merely proving the preceding closed-reference checksum check.
  for(const stage of stages)for(const stream of ['stdout','stderr'] as const)if(stage[stream]===reference){const actual=JSON.parse(values.get(stage.receipt.path)!.toString());actual[stream]={path:stream+'.raw',bytes:reference.bytes,sha256:reference.sha256};rewrite(stage.receipt,actual);}
 };
 const stageJSON=(index:number,role:string,change:(value:any)=>void)=>{const reference=(stages[index] as any)[role],value=JSON.parse(read(reference,4*1024**2).toString());change(value);rewrite(reference,value);};
 return {master,read,candidateVersion:version,job:{started_at:'1970-01-01T00:00:00.000Z',completed_at:'1970-01-01T00:00:01.000Z'},values,rewrite,stageJSON,body};
}
