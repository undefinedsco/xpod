import{test,expect}from'bun:test';import{createHash}from'node:crypto';
import{inspectCandidateServiceOriginalUniverse as inspect}from'../../scripts/lib/independent-admission/qlever-sdk-service-relationship';
const sha=(raw:Buffer)=>createHash('sha256').update(raw).digest('hex');
function fixture(){
 const data=new Map<string,Buffer>([['service-image-materials.json',Buffer.from('{}')],['metadata.json',Buffer.from('{}')]]);
 const body=Buffer.alloc(4*1024**2+1,17),digest=sha(body),bodyPath='output/service-pack-bodies/objects/0001-'+digest+'.original',tarPath='stages/service-output-copy-pack-body-0001/stdout.raw',phasePath='stages/service-output-copy-pack-phase/stdout.raw';data.set(bodyPath,body);data.set(tarPath,Buffer.concat([body,Buffer.alloc(512)]));data.set(phasePath,Buffer.from('phase-tar'));
 const ref=(path:string)=>({path,bytes:data.get(path)!.length,sha256:sha(data.get(path)!)});
 const master:any={originals:[...data.keys()].filter(p=>p!=='service-image-materials.json').map(ref),packInputObservation:{schemaVersion:1,kind:'actual-stopped-service-image-pack-inputs',phase:{stage:{stdout:ref(phasePath)}},bodies:[{original:ref(bodyPath),rawTarOriginal:ref(tarPath),stage:{stdout:ref(tarPath)}}]}};
 let calls=0,small=0;const view:any={members:[...data.keys()].map(ref),readOriginal(){small++;throw Error('full-buffer read forbidden');},readOriginalRange(path:string,offset:number,length:number){calls++;expect(length<=65536).toBe(true);return data.get(path)!.subarray(offset,offset+length);}};
 return{view,master,data,bodyPath,tarPath,phasePath,counts:()=>({calls,small})};
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
 const f=fixture();f.view.members[0].bytes=128*1024**2;expect(()=>inspect(f.view,f.master)).toThrow();expect(f.counts().calls).toBe(0);
 for(const mode of['drift','short']){const g=fixture(),read=g.view.readOriginalRange;g.view.readOriginalRange=(p:string,o:number,n:number)=>{const b=read(p,o,n);return mode==='short'?b.subarray(0,Math.max(0,b.length-1)):Buffer.alloc(n);};expect(()=>inspect(g.view,g.master)).toThrow();}
});
test('actual collector capture master supplies the same top-level pack shape and ordinal member paths',()=>{
 const {spawnSync}=require('node:child_process');const path=require('node:path');
 const run=spawnSync('python3',['-I','-S','-B',path.join(import.meta.dirname,'service-pack-relationship-producer.py')],{encoding:'utf8',timeout:10000,maxBuffer:4*1024**2});expect(run.status).toBe(0);if(run.status!==0)throw Error(run.stderr);
 const actual=JSON.parse(run.stdout);expect(actual.master.packInputObservation.kind).toBe('actual-stopped-service-image-pack-inputs');expect(actual.master.outputImageObservation.packInputObservation).toBeUndefined();expect(actual.master.packInputObservation.bodies[0].original.path.startsWith('output/service-pack-bodies/objects/0001-')).toBe(true);
 const data=new Map<string,Buffer>(Object.entries(actual.data).map(([p,b])=>[p,Buffer.from(b as string,'base64')]));inspect({members:actual.members,readOriginalRange(p:string,o:number,n:number){return data.get(p)!.subarray(o,o+n);}}as any,actual.master);
});
