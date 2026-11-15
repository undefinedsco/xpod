/** Pure reader bridge: replays the source-owned ELF parser over caller-held
 * bytes only. No image/source qualification is claimed or issued here. */
import{expect,test}from'bun:test';
import{readFileSync}from'node:fs';
import{createHash}from'node:crypto';
import{resolve}from'node:path';
import{replayCandidateServiceElfLoader}from'../../scripts/lib/independent-admission/candidate-service-abi-role-replay';
const SOURCE=readFileSync(resolve('qlever/scripts/sdk-service-abi-elf.py'));
const HEADER=64,PHENTRY=56,MAXRANGE=64*1024;
/** Minimal executable ELF64LE x64: 64-byte header plus one 56-byte entry. */
function minimalElf(options:{interpreter?:string;phnum?:number;declaredFilesz?:number}={}):Buffer{
 const interpreter=options.interpreter===undefined?undefined:Buffer.from(options.interpreter+'\0','utf8'),dataOffset=HEADER+PHENTRY,size=dataOffset+(interpreter?.length??0);
 const dynamic=interpreter!==undefined,bytes=Buffer.alloc(size);
 bytes.set([0x7f,0x45,0x4c,0x46,2,1,1],0);
 bytes.writeUInt16LE(2,16);bytes.writeUInt16LE(62,18);bytes.writeUInt32LE(1,20);
 bytes.writeBigUInt64LE(BigInt(HEADER),32);
 bytes.writeUInt16LE(HEADER,52);bytes.writeUInt16LE(PHENTRY,54);bytes.writeUInt16LE(options.phnum??1,56);
 bytes.writeUInt32LE(dynamic?3:1,HEADER);bytes.writeUInt32LE(0,HEADER+4);
 bytes.writeBigUInt64LE(dynamic?BigInt(dataOffset):0n,HEADER+8);
 bytes.writeBigUInt64LE(0n,HEADER+16);bytes.writeBigUInt64LE(0n,HEADER+24);
 const filesz=options.declaredFilesz??(dynamic?interpreter.length:size);
 bytes.writeBigUInt64LE(BigInt(filesz),HEADER+32);bytes.writeBigUInt64LE(BigInt(filesz),HEADER+40);bytes.writeBigUInt64LE(0n,HEADER+48);
 if(interpreter)bytes.set(interpreter,dataOffset);
 return bytes;
}
function harness(){
 const ranges:Array<[number,number]>=[],controls={guards:0};
 const run=(bytes:Buffer,guard:()=>void=()=>{})=>replayCandidateServiceElfLoader({
  source:SOURCE,bytes:bytes.length,
  read(offset,length){ranges.push([offset,length]);return bytes.subarray(offset,offset+length);},
  budget:{check(){},remainingMs(){return 60000;}},
  guard(){controls.guards++;guard();},
 });
 return{ranges,run,guards:()=>controls.guards};
}
test('actual source parser replays minimal static PT_LOAD over exact 64+56 ranges',()=>{
 const h=harness(),bytes=minimalElf();
 expect(h.run(bytes)).toEqual({kind:'static',machine:62});
 expect(h.ranges).toEqual([[0,64],[64,56]]);
 expect(h.ranges.every(([offset,length])=>offset+length<=bytes.length&&length<=MAXRANGE)).toBe(true);
 expect(h.guards()).toBe(3);
});
test('actual source parser replays PT_INTERP path over exact ranges bounded by 64 KiB',()=>{
 const h=harness(),interpreter='/lib64/ld-linux-x86-64.so.2',bytes=minimalElf({interpreter});
 expect(h.run(bytes)).toEqual({kind:'dynamic',machine:62,interpreter});
 const segment=Buffer.from(interpreter+'\0','utf8').length;
 expect(h.ranges).toEqual([[0,64],[64,56],[120,segment]]);
 expect(h.ranges.every(([,length])=>length>=1&&length<=MAXRANGE)).toBe(true);
 expect(h.ranges.reduce((total,[,length])=>total+length,0)).toBe(bytes.length);
});
test('actual bounded table refuses out-of-range phnum and interpreter length',()=>{
 const table=harness(),claimed=minimalElf({phnum:2000});
 expect(()=>table.run(claimed)).toThrow('Bounded complete actual ELF program table');
 expect(table.ranges).toEqual([[0,64]]);
 const segment=harness(),oversized=minimalElf({interpreter:'/x',declaredFilesz:4097});
 expect(()=>segment.run(oversized)).toThrow('Bounded actual interpreter');
 expect(segment.ranges).toEqual([[0,64],[64,56]]);
});
test('actual parent check exception aborts the replay before any read',()=>{
 const h=harness(),bytes=minimalElf({interpreter:'/lib64/ld-linux-x86-64.so.2'}),revoked=Error('parent qualification revoked');
 let thrown:unknown;
 try{h.run(bytes,()=>{throw revoked;});}catch(error){thrown=error;}
 expect(thrown).toBe(revoked);
 expect((thrown as Error).message).toBe('parent qualification revoked');
 expect(h.ranges).toEqual([]);
 expect(h.guards()).toBe(1);
});

/** Role-command replay: the retained execution identity is the ONLY authority.
 * The verifier never derives its own euid/egid, so a remote CI replay of a local
 * record must validate against the recorded tuple. */
import{replayCandidateServiceRoleCommands}from'../../scripts/lib/independent-admission/candidate-service-abi-role-replay';
import{SERVICE_ABI_ROLE_SOURCES}from'../../scripts/lib/independent-admission/candidate-service-abi-role-replay';

const ROLE='bun-node-addon';
const NONCE='e'.repeat(32);
const CID='b'.repeat(64);
const IMAGE='ghcr.io/undefinedsco/xpod@sha256:'+'c'.repeat(64);
const CONFIG='sha256:'+'d'.repeat(64);
const PROBE='/tmp/sdk-service-abi-role-probe.mjs';
const IDENTITY=[1001,1002] as const;
const ROLE_OPS=['create','inspect','wait','inspect','inspect','remove','absent'] as const;

/** The verifier request names modules by the two keys the worker actually uses. */
const WORKER_MODULES:Record<string,string>={'commands':SERVICE_ABI_ROLE_SOURCES[0]!,'collector':SERVICE_ABI_ROLE_SOURCES[1]!};

function workerSources():Record<string,string>{
 const out:Record<string,string>={};
 for(const [key,path] of Object.entries(WORKER_MODULES))out[key]=readFileSync(resolve(path)).toString('base64');
 return out;
}
function roleSources(){
 const map=new Map<string,Buffer>();
 for(const p of SERVICE_ABI_ROLE_SOURCES)map.set(p,readFileSync(resolve(p)));
 return map;
}

/** Reproduce the REAL producer command shapes for one successful role universe. */
async function producerRecord(identity:readonly number[]|undefined){
 const {execFileSync}=await import('node:child_process');
 const code=String.raw`
import base64,json,sys,types
r=json.loads(sys.stdin.buffer.read(4*1024**2+1))
def module(key):
 m=types.ModuleType(key);exec(compile(base64.b64decode(r['sources'][key],validate=True),key,'exec'),m.__dict__);return m
commands=module('commands')
identity=r.get('identity')
ops=['create','inspect','wait','inspect','inspect','remove','absent']
start=commands.command(r['role'],'start',image=r['image'],nonce=r['nonce'],cid=r['cid'])
out=[]
for op in ops:
 kw={'probe':r['probe']} if op=='create' else {'cid':r['cid']}
 if op=='create':
  if identity is None:
   out.append(commands.command(r['role'],op,image=r['image'],nonce=r['nonce'],**kw));continue
  kw['identity']=tuple(identity)
 out.append(commands.command(r['role'],op,image=r['image'],nonce=r['nonce'],**kw))
print(json.dumps({'commands':out,'start':start}))
`;
 const sources=workerSources();
 const request=JSON.stringify({sources,probe:PROBE,cid:CID,role:ROLE,nonce:NONCE,image:IMAGE,identity});
 const produced=JSON.parse(execFileSync('/usr/bin/python3',['-I','-S','-B','-c',code],{input:Buffer.from(request),maxBuffer:1024**2}).toString()) as {commands:string[][];start:string[]};
 const commands=produced.commands,startCommand=produced.start;
 const inspectRecord=(user:string,tmpfsOwner:string,before=false)=>JSON.stringify([{Id:CID,Name:'/xpod-service-abi-'+ROLE+'-'+NONCE,Image:CONFIG,
  Config:{Image:IMAGE,User:user,Entrypoint:['/usr/local/bin/bun'],Cmd:['/probe.mjs',ROLE,NONCE],
   Labels:{'org.xpod.service-abi-owner':NONCE,'org.xpod.service-abi-role':ROLE}},
  HostConfig:{ReadonlyRootfs:true,NetworkMode:'none',CapDrop:['ALL'],Init:true,Memory:512*1024**2,PidsLimit:64,NanoCpus:10**9,RestartPolicy:{Name:'no'},SecurityOpt:['no-new-privileges'],
   Tmpfs:{'/scratch':'rw,noexec,nosuid,nodev,size=8388608,mode=0700,uid='+tmpfsOwner.split(':')[0]+',gid='+tmpfsOwner.split(':')[1],
          '/tmp':'rw,noexec,nosuid,nodev,size=16777216,mode=0700,uid='+tmpfsOwner.split(':')[0]+',gid='+tmpfsOwner.split(':')[1]}},
  State:before?{Status:'created',Running:false,Pid:0,ExitCode:0,OOMKilled:false}:{Status:'exited',Running:false,Pid:0,ExitCode:0,OOMKilled:false},
  Mounts:[{Type:'bind',Source:PROBE,Destination:'/probe.mjs',RW:false}]}]);
 // The inspect bodies must describe the SAME tuple that was bound into the record.
 const owner=identity===undefined?'1001:1002':identity[0]+':'+identity[1];
 const outputs=[
  Buffer.from(CID+'\n'),
  Buffer.from(inspectRecord(owner,owner,true)),
  Buffer.from('0\n'),
  Buffer.from(inspectRecord(owner,owner)),
  Buffer.from(inspectRecord(owner,owner)),
  Buffer.from(CID+'\n'),
  Buffer.from(''),
 ];
 return {commands,outputs,inspectRecord,
  record:{
   role:ROLE,ownerNonce:NONCE,containerId:CID,imageReferenceByDigest:IMAGE,configDigest:CONFIG,
   containerName:'xpod-service-abi-'+ROLE+'-'+NONCE,
   ...(identity===undefined?{}:{executionIdentity:[...identity]}),
   stages:ROLE_OPS.map((operation,i)=>({operation,command:commands[i]})),
   session:{observation:{command:startCommand}},
  }} as any;
}

function replay(record:any,outputs:Buffer[],sources=roleSources()){
 return replayCandidateServiceRoleCommands({sources,record,outputs,
  budget:{check(){},remainingMs:()=>60000},guard(){}});
}

test('current producer record with bound identity replays through current source',async()=>{
 const f=await producerRecord(IDENTITY);
 expect(f.record.executionIdentity).toEqual([1001,1002]);
 expect(replay(f.record,f.outputs)).toBeUndefined();
});

test('missing retained identity is rejected',async()=>{
 const f=await producerRecord(IDENTITY);
 delete f.record.executionIdentity;
 expect(()=>replay(f.record,f.outputs)).toThrow(/retained bound execution identity/);
});

test('altered retained identity is rejected against the recorded commands',async()=>{
 const f=await producerRecord(IDENTITY);
 f.record.executionIdentity=[0,0];
 expect(()=>replay(f.record,f.outputs)).toThrow(/source command differs/);
});

test('wrong container user or tmpfs owner in the inspect record is rejected',async()=>{
 const f=await producerRecord(IDENTITY);
 const bad1=[...f.outputs];bad1[1]=Buffer.from(f.inspectRecord('0:0','1001:1002'));
 expect(()=>replay(f.record,bad1)).toThrow(/actual role execution identity differs/);
 const bad2=[...f.outputs];bad2[1]=Buffer.from(f.inspectRecord('1001:1002','1001:1003'));
 expect(()=>replay(f.record,bad2)).toThrow(/actual bounded role scratch differs/);
});

test('invalid retained identity shapes are rejected before any command replay',async()=>{
 for(const bad of [[0xFFFFFFFF,1],[1],[true,1],[-1,1],['1',2],[1.5,2]]){
  const f=await producerRecord(IDENTITY);
  f.record.executionIdentity=bad;
  expect(()=>replay(f.record,f.outputs)).toThrow();
 }
});

test('identity is bound to the source, not to the verifier host',async()=>{
 const f=await producerRecord(IDENTITY);
 // A record produced with a different but internally consistent tuple still replays,
 // proving the verifier does not substitute its own euid/egid.
 const g=await producerRecord([0,0]);
 expect(replay(g.record,g.outputs)).toBeUndefined();
 expect(f.record.executionIdentity).toEqual([1001,1002]);
});

/** END-TO-END: the record below was produced by the REAL role_collector.collect
 *  (run through the existing scripted-Docker unittest harness), not hand-assembled.
 *  This is the regression that would have caught a missing executionIdentity field.
 *  Scope: scripted-Docker data mechanics, not real container acceptance. */
const PRODUCED=JSON.parse(readFileSync(resolve('tests/fixtures/independent-admission/dd7-produced-role-record.json'),'utf8'));

test('REAL producer record replays through current source',()=>{
 expect(PRODUCED.record.executionIdentity).toEqual([1000,1000]);
 expect(PRODUCED.record.stages.length).toBe(7);
 const outputs=(PRODUCED.outputs as string[]).map(v=>Buffer.from(v,'base64'));
 expect(replay(PRODUCED.record,outputs)).toBeUndefined();
});

test('REAL producer record fails closed when executionIdentity is removed',()=>{
 const missing=structuredClone(PRODUCED.record);delete missing.executionIdentity;
 const outputs=(PRODUCED.outputs as string[]).map(v=>Buffer.from(v,'base64'));
 // A missing tuple with CURRENT source must reject: the builder requires it.
 expect(()=>replay(missing,outputs)).toThrow();
});

test('REAL producer record rejects an altered tuple and drifted inspect bodies',()=>{
 const outputs=(PRODUCED.outputs as string[]).map(v=>Buffer.from(v,'base64'));
 const wrong=structuredClone(PRODUCED.record);wrong.executionIdentity=[1000,1001];
 expect(()=>replay(wrong,outputs)).toThrow(/source command differs/);
 const badUser=[...outputs];
 const p1=JSON.parse(badUser[1]!.toString('utf8'));p1[0].Config.User='0:0';
 badUser[1]=Buffer.from(JSON.stringify(p1));
 expect(()=>replay(PRODUCED.record,badUser)).toThrow(/execution identity differs/);
 const badOwner=[...outputs];
 const p2=JSON.parse(badOwner[1]!.toString('utf8'));
 p2[0].HostConfig.Tmpfs['/scratch']='rw,noexec,nosuid,nodev,size=8388608,mode=0700,uid=1000,gid=1099';
 badOwner[1]=Buffer.from(JSON.stringify(p2));
 expect(()=>replay(PRODUCED.record,badOwner)).toThrow(/bounded role scratch differs/);
});

/** HISTORICAL contract: a pre-identity record replays ONLY against its own historical
 *  sources via the original call form. Fixtures are frozen from dd7 and byte-checked. */
const DD7_COMMANDS=readFileSync(resolve('tests/fixtures/independent-admission/dd7-role-commands.py'));
const DD7_COLLECTOR=readFileSync(resolve('tests/fixtures/independent-admission/dd7-role-collector.py'));
const DD7_COMMANDS_SHA='8f4ba44953e454876c73e51421055443e1906a8edb00780c4f457d00e4c2f06c';
const DD7_COLLECTOR_SHA='ce1e262a6d1a84aa45d208b63b9d5e8c2001cc7d5acb88280711a07811b050b4';

function sha256(b:Buffer){return createHash('sha256').update(b).digest('hex');}

function legacySources(){
 return new Map<string,Buffer>([[SERVICE_ABI_ROLE_SOURCES[0]!,DD7_COMMANDS],
  [SERVICE_ABI_ROLE_SOURCES[1]!,DD7_COLLECTOR]]);
}

test('dd7 historical fixtures are byte-identical to the frozen sources',()=>{
 expect(sha256(DD7_COMMANDS)).toBe(DD7_COMMANDS_SHA);
 expect(sha256(DD7_COLLECTOR)).toBe(DD7_COLLECTOR_SHA);
});

test('old record replays against old source, and both mismatched combinations reject',()=>{
 const legacy=structuredClone(PRODUCED.record);delete legacy.executionIdentity;
 // The historical inspect originals carry no Config.User and no tmpfs ownership.
 const strip=(b:Buffer)=>{const p=JSON.parse(b.toString('utf8'));
  delete p[0].Config.User;
  p[0].HostConfig.Tmpfs={'/scratch':'rw,noexec,nosuid,nodev,size=8388608,mode=0700',
                         '/tmp':'rw,noexec,nosuid,nodev,size=16777216,mode=0700'};
  return Buffer.from(JSON.stringify(p));};
 const outputs=(PRODUCED.outputs as string[]).map(v=>Buffer.from(v,'base64'));
 for(const i of [1,3,4])outputs[i]=strip(outputs[i]!);
 // Rebuild the historical stage commands from the FROZEN dd7 builder, using the probe
 // path that is actually recorded in the create mount.
 const probePath=(PRODUCED.record.stages[0]!.command as string[])
  .find((v:string)=>v.startsWith('type=bind,src='))!
  .replace('type=bind,src=','').replace(',dst=/probe.mjs,readonly','');
 const {execFileSync}=require('node:child_process') as typeof import('node:child_process');
 const code=String.raw`
import base64,json,sys,types
r=json.loads(sys.stdin.buffer.read(4*1024**2+1))
m=types.ModuleType('commands');exec(compile(base64.b64decode(r['src'],validate=True),'commands','exec'),m.__dict__)
ops=['create','inspect','wait','inspect','inspect','remove','absent']
print(json.dumps({'cmds':[m.command(r['role'],o,image=r['image'],nonce=r['nonce'],**({'probe':r['probe']}if o=='create'else{'cid':r['cid']}))for o in ops],'start':m.command(r['role'],'start',image=r['image'],nonce=r['nonce'],cid=r['cid'])}))
`;
 const request=JSON.stringify({src:DD7_COMMANDS.toString('base64'),role:legacy.role,
  image:legacy.imageReferenceByDigest,nonce:legacy.ownerNonce,cid:legacy.containerId,probe:probePath});
 const produced=JSON.parse(execFileSync('/usr/bin/python3',['-I','-S','-B','-c',code],
  {input:Buffer.from(request),maxBuffer:1024**2}).toString()) as {cmds:string[][];start:string[]};
 const legacyCommands=produced.cmds;
 legacy.stages=legacy.stages.map((st:any,i:number)=>({operation:st.operation,command:legacyCommands[i]}));
 legacy.session={observation:{command:produced.start}};
 // 1. old record + old source: the historical contract must still pass.
 expect(replay(legacy,outputs,legacySources())).toBeUndefined();
 // 2. old record + CURRENT source: the current builder requires the identity.
 expect(()=>replay(legacy,outputs)).toThrow();
 // 3. old source + NEW record tuple: the historical builder has no identity kwarg.
 expect(()=>replay(PRODUCED.record,outputs,legacySources())).toThrow();
});
