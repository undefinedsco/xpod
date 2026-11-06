/** Byte protocol fixture only. This creates no issuer or native capability. */
import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {inspectCandidateServiceRelationship as inspect} from '../../scripts/lib/independent-admission/qlever-sdk-service-relationship';
const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const OCI_MANIFEST='application/vnd.oci.image.manifest.v1+json';
const OCI_INDEX='application/vnd.oci.image.index.v1+json';
const DOCKER_MANIFEST='application/vnd.docker.distribution.manifest.v2+json';
const DOCKER_LIST='application/vnd.docker.distribution.manifest.list.v2+json';
type Variant={serviceShape?:'manifest'|'index';descriptorMediaType?:string;childMediaType?:string;attestation?:boolean;dropPlatformManifest?:boolean;metadataConfigDigest?:boolean};
function fixture(bad?:string,variant:Variant={}):any {
 const sha='a'.repeat(40),files=new Map<string,Buffer>();const put=(path:string,value:unknown)=>{const data=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));files.set(path,data);return {path,bytes:data.length,sha256:hash(data)};};
 const images:any={};for(const role of ['service','localRuntime','sdk']){
  const config=put(role+'/config.json',{os:'linux',architecture:'amd64',rootfs:{diff_ids:role==='service'?['sha256:'+'1'.repeat(64),'sha256:'+'2'.repeat(64)]:['sha256:'+'1'.repeat(64)]},config:{Labels:{'org.opencontainers.image.revision':sha,'org.opencontainers.image.source':'https://github.com/undefinedsco/xpod'}}});
  const repository=({service:'xpod',localRuntime:'xpod-qlever-local-runtime',sdk:'xpod-qlever-sdk'} as any)[role];
  const childMediaType=variant.childMediaType??OCI_MANIFEST;
  if(role==='service'&&variant.serviceShape==='index'){
   // A real multi-platform result: one linux/amd64 child plus an unknown/unknown
   // attestation row, selected by platform rather than by name.
   const child=put('service/platform-manifest.json',{mediaType:childMediaType,config:{digest:'sha256:'+config.sha256}});
   const rows:any[]=[{mediaType:childMediaType,digest:'sha256:'+child.sha256,platform:{os:'linux',architecture:'amd64'}}];
   if(variant.attestation!==false){
    const attestation=put('service/attestation-manifest.json',{mediaType:childMediaType,config:{digest:'sha256:'+'9'.repeat(64)}});
    rows.push({mediaType:childMediaType,digest:'sha256:'+attestation.sha256,platform:{os:'unknown',architecture:'unknown'},annotations:{'vnd.docker.reference.type':'attestation-manifest'}});
   }
   const indexMediaType=variant.descriptorMediaType??OCI_INDEX;
   const index=put('service/index.json',{mediaType:indexMediaType,manifests:rows});
   images[role]={referenceByDigest:'ghcr.io/undefinedsco/'+repository+'@sha256:'+index.sha256,configDigest:'sha256:'+config.sha256,manifestOriginal:index,configOriginal:config};
   if(variant.dropPlatformManifest!==true)images[role].platformManifestOriginal=child;
   continue;
  }
  const manifest=put(role+'/manifest.json',{mediaType:childMediaType,config:{digest:'sha256:'+config.sha256}});
  images[role]={referenceByDigest:'ghcr.io/undefinedsco/'+repository+'@sha256:'+manifest.sha256,configDigest:'sha256:'+config.sha256,manifestOriginal:manifest,configOriginal:config};
 }
 const serviceDigest=images.service.referenceByDigest.split('@')[1];
 const descriptorMediaType=variant.descriptorMediaType??(variant.serviceShape==='index'?OCI_INDEX:OCI_MANIFEST);
 const buildMetadata:any={'containerimage.digest':serviceDigest,'containerimage.descriptor':{'mediaType':descriptorMediaType,'digest':serviceDigest}};
 // Only the single-manifest shape reports a config digest; the index shape must
 // never invent one (that is the actual RC375 metadata shape).
 if(variant.serviceShape!=='index')buildMetadata['containerimage.config.digest']=images.service.configDigest;
 if(variant.metadataConfigDigest===true)buildMetadata['containerimage.config.digest']=images.service.configDigest;
 const before=Buffer.from('{"name":"@undefineds.co/xpod","version":"1.0.0"}');const sourceOriginals={rootManifestBefore:put('before.json',before),rootManifestAfter:put('after.json',Buffer.from('{"name":"@undefineds.co/xpod","version":"1.0.1"}')),buildMetadata:put('build-metadata.json',buildMetadata)};
 const stages=['head','manifest','status'].map((mode,index)=>{const name='service-source-'+mode,parent='stages/'+name+'/';const stdout=put(parent+'stdout.raw',mode==='head'?Buffer.from(sha+'\n'):mode==='manifest'?before:Buffer.from(' M package.json\n'));const stderr=put(parent+'stderr.raw',Buffer.alloc(0));const raw=put('stages/'+name+'.raw.log',Buffer.from('actual wrapper raw'));
 const receipt=put(parent+'command.receipt.json',{command:['/usr/bin/python3','-I','-S','-B','/work/source/qlever/scripts/sdk-service-image-originals.py','--worker',mode,'--source','/work/source','--source-sha',sha],pgid:3,exit:0,signal:null,actualWait:bad!=='wait',rawClosedBeforeHash:true,startedUnixNs:bad==='outside'?3e9:1e7+index*1e7,completedUnixNs:bad==='outside'?3e9+1:1e7+index*1e7+1,stdout:{...stdout,path:'stdout.raw'},stderr:{...stderr,path:'stderr.raw'}});
 const supervision:any={exit:0,signal:null,actualWait:true,rawClosedBeforeHash:true,ownedGroupAbsentAfterWait:true,resourceStop:null,supervisorError:null,cleanupErrors:[],pgid:3,rawSHA256:bad==='raw'?'f'.repeat(64):raw.sha256};
 if(bad==='missing-resourceStop')delete supervision.resourceStop;if(bad==='missing-supervisorError')delete supervision.supervisorError;if(bad==='missing-cleanupErrors')delete supervision.cleanupErrors;
 const supervisor=put('stages/'+name+'.receipt.json',supervision);return {name,receipt,stdout,stderr,supervisionReceipt:supervisor,supervisionRaw:raw};});
 put('service-image-materials.json',{schemaVersion:1,kind:'xpod-candidate-service-image-originals',releaseAccepted:false,sourceSha:sha,runHeadSha:sha,runId:1,runAttempt:1,target:'linux-x64',sdkProfile:'service-trixie',sourcePath:'/work/source',controllerPath:'/work/source/qlever/scripts/sdk-service-image-originals.py',sourceOriginals,stages,images,serviceImageReferenceByDigest:images.service.referenceByDigest,localRuntimeImageReferenceByDigest:images.localRuntime.referenceByDigest,sdkArtifact:{sdkImageReferenceByDigest:images.sdk.referenceByDigest},originals:[...files].map(([path,data])=>({path,bytes:data.length,sha256:hash(data)}))});
 return {originFacts:{sourceSha:sha,runHeadSha:sha,runId:1,runAttempt:1,producerJobId:7},metadataOriginals:[{name:'jobs.original.json',data:Buffer.from(JSON.stringify({jobs:[{id:7,started_at:'1970-01-01T00:00:00Z',completed_at:'1970-01-01T00:00:01Z'}]}))}],members:[...files].map(([path,data])=>({path,bytes:data.length,sha256:hash(data),mode:0o100644})),readOriginal:(path:string)=>files.get(path)!,readOriginalRange:(path:string,offset:number,length:number)=>files.get(path)!.subarray(offset,offset+length)};
}
test('service original graph binds registry bytes and actual closed command windows without issuing authority',()=>{expect(inspect(fixture()).target).toBe('linux-x64');for(const bad of ['wait','outside','raw','missing-resourceStop','missing-supervisorError','missing-cleanupErrors'])expect(()=>inspect(fixture(bad))).toThrow();});

test('OCI index metadata binds linux/amd64 child + attestation through the real config chain (RC375 shape)',()=>{
 // The actual RC375 shape: an index, one linux/amd64 child, an unknown/unknown
 // attestation row, and NO containerimage.config.digest in the metadata.
 const value=fixture(undefined,{serviceShape:'index',attestation:true});
 expect(inspect(value).target).toBe('linux-x64');
 // Same index without the attestation row still passes (selection is by platform).
 expect(inspect(fixture(undefined,{serviceShape:'index',attestation:false})).target).toBe('linux-x64');
 // The platform child is not optional: the consumer must not fall back to the
 // index when the child original is missing.
 expect(()=>inspect(fixture(undefined,{serviceShape:'index',dropPlatformManifest:true}))).toThrow(/unique actual image platform manifest/u);
 // An index result that nonetheless carries a config digest is a contradictory
 // shape and must not be accepted by the config branch.
 expect(()=>inspect(fixture(undefined,{serviceShape:'index',metadataConfigDigest:true}))).toThrow(/actual build action\/registry config cross-seal/u);
});

test('Docker manifest v2 and Docker manifest list are accepted exactly as the producer declares',()=>{
 // buildx emits Docker media types when OCI output is disabled. The producer
 // accepts manifest v2 / manifest list, so the consumer must too - and no more.
 expect(inspect(fixture(undefined,{descriptorMediaType:DOCKER_MANIFEST,childMediaType:DOCKER_MANIFEST})).target).toBe('linux-x64');
 expect(inspect(fixture(undefined,{serviceShape:'index',descriptorMediaType:DOCKER_LIST,childMediaType:DOCKER_MANIFEST})).target).toBe('linux-x64');
 // Unknown media types stay refused in both branches.
 for(const variant of [
  {descriptorMediaType:'application/vnd.example.unknown+json'},
  {serviceShape:'index' as const,descriptorMediaType:'application/vnd.example.unknown+json'},
 ])expect(()=>inspect(fixture(undefined,variant))).toThrow(/actual build action/u);
 // A manifest descriptor on an index result (and vice versa) is a mismatch.
 expect(()=>inspect(fixture(undefined,{serviceShape:'index',descriptorMediaType:OCI_MANIFEST}))).toThrow(/actual build action index\/platform cross-seal/u);
 expect(()=>inspect(fixture(undefined,{descriptorMediaType:OCI_INDEX}))).toThrow(/actual build action\/registry config cross-seal/u);
});
