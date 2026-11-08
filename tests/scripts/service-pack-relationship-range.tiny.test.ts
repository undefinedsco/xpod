import{test,expect}from'bun:test';import{createHash}from'node:crypto';
import{inspectCandidateServiceOriginalUniverse as inspect}from'../../scripts/lib/independent-admission/qlever-sdk-service-relationship';
const sha=(raw:Buffer)=>createHash('sha256').update(raw).digest('hex');
function fixture(){
 const data=new Map<string,Buffer>([['service-image-materials.json',Buffer.from('{}')],['metadata.json',Buffer.from('{}')]]);
 const body=Buffer.alloc(4*1024**2+1,17),digest=sha(body),bodyPath='output/service-pack-bodies/objects/0001-'+digest+'.original',tarPath='stages/service-output-copy-pack-body-0001/stdout.raw',phasePath='stages/service-output-copy-pack-phase/stdout.raw',packTapPath='stages/service-output-copy-pack-inputs/stdout.raw';data.set(bodyPath,body);data.set(tarPath,Buffer.concat([body,Buffer.alloc(512)]));data.set(phasePath,Buffer.from('phase-tar'));data.set(packTapPath,Buffer.concat([Buffer.from('pack-index'),Buffer.alloc(512)]));
 const ref=(path:string)=>({path,bytes:data.get(path)!.length,sha256:sha(data.get(path)!)});
 const master:any={originals:[...data.keys()].filter(p=>p!=='service-image-materials.json').map(ref),packInputObservation:{schemaVersion:1,kind:'actual-stopped-service-image-pack-inputs',stage:{stdout:ref(packTapPath)},phase:{stage:{stdout:ref(phasePath)}},bodies:[{original:ref(bodyPath),rawTarOriginal:ref(tarPath),stage:{stdout:ref(tarPath)}}]}};
 let calls=0,small=0;const view:any={members:[...data.keys()].map(ref),readOriginal(){small++;throw Error('full-buffer read forbidden');},readOriginalRange(path:string,offset:number,length:number){calls++;expect(length<=65536).toBe(true);return data.get(path)!.subarray(offset,offset+length);}};
 return{view,master,data,bodyPath,tarPath,phasePath,packTapPath,counts:()=>({calls,small})};
}
test('exact typed pack body and raw TAR members use bounded ranges and full SHA without issuing facts',()=>{const f=fixture();expect(inspect(f.view,f.master)).toBeUndefined();expect(f.counts().calls>128).toBe(true);expect(f.counts().small).toBe(0);});
test('legacy metadata remains small; JSON-only role declarations cannot authorize arbitrary large originals',()=>{
 for(const mutation of['no-pack','wrong-kind','wrong-path','missing-raw-stage','duplicate','extra-large']){
  const f=fixture(),pack=f.master.packInputObservation;
  if(mutation==='no-pack')delete f.master.packInputObservation;
  if(mutation==='wrong-kind')pack.kind='caller-declared';
  if(mutation==='wrong-path')pack.bodies[0].original.path='arbitrary.bin';
  if(mutation==='missing-raw-stage')delete pack.bodies[0].stage;
  if(mutation==='duplicate')pack.bodies.push(pack.bodies[0]);
  if(mutation==='extra-large'){const ref={path:'extra.raw',bytes:4*1024**2+1,sha256:'a'.repeat(64)};f.master.originals.push(ref);f.view.members.push(ref);}
  expect(()=>inspect(f.view,f.master)).toThrow();
 }
 const data=Buffer.from('legacy'),row={path:'legacy.json',bytes:data.length,sha256:sha(data)};let reads=0;const view:any={members:[{path:'service-image-materials.json',bytes:2,sha256:sha(Buffer.from('{}'))},row],readOriginalRange(){reads++;return data;}};inspect(view,{originals:[row]});expect(reads).toBe(1);
});
test('actual closed member budget is checked before reads and byte drift/truncation cannot pass',()=>{
 // A member above the PRODUCER'S OWN transport bound is still refused, and still
 // refused BEFORE any range read. (128 MiB used to be the threshold, but that was a
 // metadata-derived number; the reviewed artifact contract's packedBytes is 768 MiB.)
 const {packedBytes}=require('../../scripts/lib/module-artifact-limits.json');
 const f=fixture();f.view.members[0].bytes=packedBytes+1;expect(()=>inspect(f.view,f.master)).toThrow();expect(f.counts().calls).toBe(0);
 for(const mode of['drift','short']){const g=fixture(),read=g.view.readOriginalRange;g.view.readOriginalRange=(p:string,o:number,n:number)=>{const b=read(p,o,n);return mode==='short'?b.subarray(0,Math.max(0,b.length-1)):Buffer.alloc(n);};expect(()=>inspect(g.view,g.master)).toThrow();}
});
test('actual RC379 pack metadata TAR above one 4MiB limit but inside the producer observation bound is admitted',()=>{
 // RC379 real master shape: stages/service-output-copy-pack-inputs/stdout.raw was
 // 5,070,336 bytes including the index, object originals, and TAR framing.
 // The generic 4MiB metadata limit rejected it although the producer's
 // own OBSERVATION_BOUNDS.metadataBytes is 8MiB, while the phase TAR stayed small.
 const {OBSERVATION_BOUNDS}=require('../../scripts/service-pack-originals.cjs');
 expect(OBSERVATION_BOUNDS.metadataBytes).toBe(8*1024**2);
 expect(OBSERVATION_BOUNDS.records).toBe(2048);
 const phaseTar=Buffer.from('phase-tar');
 // Build one master over a synthetic payload in the real >4MiB <=8MiB band.
 // The bytes are synthetic; only the shape and bounds mirror RC379.
 function harness(packTar:Buffer,packPath='stages/service-output-copy-pack-inputs/stdout.raw'){
  const data=new Map<string,Buffer>([['service-image-materials.json',Buffer.from('{}')],['metadata.json',Buffer.from('{}')],['stages/service-output-copy-pack-phase/stdout.raw',phaseTar],[packPath,packTar]]);
  const ref=(path:string)=>({path,bytes:data.get(path)!.length,sha256:sha(data.get(path)!)});
  const master:any={originals:[...data.keys()].filter(p=>p!=='service-image-materials.json').map(ref),packInputObservation:{schemaVersion:1,kind:'actual-stopped-service-image-pack-inputs',stage:{stdout:ref(packPath)},phase:{stage:{stdout:ref('stages/service-output-copy-pack-phase/stdout.raw')}},bodies:[]}};
  const view:any={members:[...data.keys()].map(ref),readOriginalRange(path:string,offset:number,length:number){expect(length<=65536).toBe(true);return data.get(path)!.subarray(offset,offset+length);}};
  return{view,master,data,ref,packTar};
 }
 const packTar=Buffer.alloc(5*1024**2+12345,3);
 expect(packTar.length).toBeGreaterThan(4*1024**2);
 expect(packTar.length<=OBSERVATION_BOUNDS.metadataBytes).toBe(true);
 const ok=harness(packTar);
 expect(inspect(ok.view,ok.master)).toBeUndefined();
 // Past the producer bound the same typed path is still refused.
 const over=harness(Buffer.alloc(OBSERVATION_BOUNDS.metadataBytes+1,4));
 expect(()=>inspect(over.view,over.master)).toThrow();
 // Another path cannot borrow the pack-inputs grant.
 const wrong=harness(packTar,'stages/service-output-copy-pack-inputs/other.raw');
 expect(()=>inspect(wrong.view,wrong.master)).toThrow();
 // Byte drift on the same typed grant is still caught by the full SHA.
 const drift=harness(packTar);
 const drifted=Buffer.from(packTar);drifted[0]^=0xff;
 drift.data.set('stages/service-output-copy-pack-inputs/stdout.raw',drifted);
 expect(()=>inspect(drift.view,drift.master)).toThrow();
});
test('actual collector capture master supplies the same top-level pack shape and ordinal member paths',()=>{
 const {spawnSync}=require('node:child_process');const path=require('node:path');
 const run=spawnSync('python3',['-I','-S','-B',path.join(import.meta.dirname,'service-pack-relationship-producer.py')],{encoding:'utf8',timeout:10000,maxBuffer:4*1024**2});
 // The child's own traceback is the only useful failure signal; surface it
 // instead of letting a bare status assertion hide the cause.
 if(run.status!==0)throw Error('service-pack-relationship-producer failed: status '+run.status+'\n'+(run.stderr||'')+(run.stdout||''));
 expect(run.status).toBe(0);
 const actual=JSON.parse(run.stdout);expect(actual.master.packInputObservation.kind).toBe('actual-stopped-service-image-pack-inputs');expect(actual.master.outputImageObservation.packInputObservation).toBeUndefined();expect(actual.master.packInputObservation.bodies[0].original.path.startsWith('output/service-pack-bodies/objects/0001-')).toBe(true);
 const data=new Map<string,Buffer>(Object.entries(actual.data).map(([p,b])=>[p,Buffer.from(b as string,'base64')]));inspect({members:actual.members,readOriginalRange(p:string,o:number,n:number){return data.get(p)!.subarray(o,o+n);}}as any,actual.master);
});
