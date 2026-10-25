/** Replay the same source-owned command/container predicate; no second policy. */
import {execFileSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {captureLegalFileIdentity,assertLegalFileIdentity,resolveExecutableIdentityPath} from './legal-file-custody';
const META=1024**2;
export const SERVICE_ABI_ROLE_SOURCES=Object.freeze(['qlever/scripts/sdk-service-abi-role-commands.py','qlever/scripts/sdk-service-abi-role-collector.py','qlever/scripts/sdk-service-abi-bun-role-session.py','qlever/scripts/sdk-service-abi-role-probe.mjs','qlever/scripts/sdk-service-abi-elf.py','qlever/scripts/sdk-service-abi-read-budget.py']);
const worker=String.raw`
import base64,json,sys,types
r=json.loads(sys.stdin.buffer.read(4*1024**2+1))
def need(v,m):
 if not v:raise ValueError(m)
def module(key):
 raw=base64.b64decode(r['sources'][key],validate=True);need(len(raw)<=1024**2,'bounded actual source');m=types.ModuleType(key);exec(compile(raw,key,'exec'),m.__dict__);return m
commands=module('commands');collector=module('collector');record=r['record'];outputs=[base64.b64decode(v,validate=True)for v in r['outputs']]
role=record['role'];nonce=record['ownerNonce'];cid=record['containerId'];image=record['imageReferenceByDigest'];config=record['configDigest'];stages=record['stages']
need(len(stages)==7 and len(outputs)==7,'complete successful role stage universe')
operations=['create','inspect','wait','inspect','inspect','remove','absent'];need([s['operation']for s in stages]==operations,'source role stage order')
create=stages[0]['command'];mount=create[create.index('--mount')+1];prefix='type=bind,src=';suffix=',dst=/probe.mjs,readonly';need(mount.startswith(prefix)and mount.endswith(suffix),'actual source probe mount');probe=mount[len(prefix):-len(suffix)]
for i,operation in enumerate(operations):
 expected=commands.command(role,operation,image=image,nonce=nonce,**({'probe':probe}if operation=='create'else{'cid':cid}))
 need(stages[i]['command']==expected,'source command differs')
need(outputs[0]==(cid+'\n').encode()and outputs[2]==b'0\n'and outputs[5]==(cid+'\n').encode()and outputs[6]==b'','actual create/wait/remove/absence differs')
for i in (1,3,4):collector.inspect_container(outputs[i],role=role,nonce=nonce,cid=cid,config=config,image=image,probe=probe,before=i==1,terminal=i!=1)
need(record['containerName']=='xpod-service-abi-'+role+'-'+nonce,'exact source role name')
need(record['session']['observation']['command']==commands.command(role,'start',image=image,nonce=nonce,cid=cid),'source-owned actual start command differs')
sys.stdout.write(json.dumps({'roleCommandReplayVerified':True})+'\n')
`;
export function replayCandidateServiceRoleCommands(input:{sources:ReadonlyMap<string,Buffer>;record:any;outputs:Buffer[];budget:{check():void;remainingMs():number};guard():void}){
 input.guard();input.budget.check();
 const source=(p:string)=>{const raw=input.sources.get(p);if(!raw||raw.length>META)throw Error('Actual bounded role source missing: '+p);return raw.toString('base64');};
 const request=Buffer.from(JSON.stringify({sources:{commands:source(SERVICE_ABI_ROLE_SOURCES[0]!),collector:source(SERVICE_ABI_ROLE_SOURCES[1]!)},record:input.record,outputs:input.outputs.map(b=>b.toString('base64'))}));
 const output=runPython(worker,request,input);
 if(!isDeepStrictEqual(JSON.parse(output.toString()),{roleCommandReplayVerified:true}))throw Error('Actual source role replay failed');
}

/** Reuse the producer's complete PT_INTERP parser on exact private ranges. */
export function replayCandidateServiceElfLoader(input:{source:Buffer;bytes:number;read(offset:number,length:number):Buffer;budget:{check():void;remainingMs():number};guard():void}){
 input.guard();input.budget.check();
 const rows:Record<string,string>={};
 const read=(offset:number,length:number)=>{input.budget.check();if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<1||length>65536||length>input.bytes-offset)throw Error('Bounded actual ELF replay range');const b=input.read(offset,length);if(b.length!==length)throw Error('Exact ELF original range');rows[offset+':'+length]=b.toString('base64');return b;};
 const header=read(0,64),phoff=Number(header.readBigUInt64LE(32)),num=header.readUInt16LE(56);
 if(!Number.isSafeInteger(phoff)||phoff<64||num<1||num>4096||num*56>input.bytes-phoff)throw Error('Bounded complete actual ELF program table');
 for(let i=0;i<num;i++){const p=read(phoff+i*56,56);if(p.readUInt32LE(0)===3){const offset=Number(p.readBigUInt64LE(8)),length=Number(p.readBigUInt64LE(32));if(length<2||length>4096)throw Error('Bounded actual interpreter');read(offset,length);}}
 const request=Buffer.from(JSON.stringify({source:input.source.toString('base64'),rows,size:input.bytes}));
 const code=String.raw`import base64,json,sys,types
r=json.loads(sys.stdin.buffer.read(4*1024**2+1));m=types.ModuleType('source_elf');exec(compile(base64.b64decode(r['source'],validate=True),'source-elf.py','exec'),m.__dict__)
print(json.dumps(m.inspect_elf_loader(lambda o,n:base64.b64decode(r['rows'][str(o)+':'+str(n)],validate=True),r['size'],lambda:None)))
`;
 return JSON.parse(runPython(code,request,input).toString()) as {kind:'static'|'dynamic';machine:number;interpreter?:string};
}
function runPython(code:string,request:Buffer,input:{budget:{check():void;remainingMs():number};guard():void}){
 if(request.length>4*META)throw Error('Role replay exceeds existing metadata ceiling');input.guard();input.budget.check();
 const python=resolveExecutableIdentityPath('/usr/bin/python3'),identity=captureLegalFileIdentity(python),remaining=input.budget.remainingMs();
 if(!Number.isFinite(remaining)||remaining<=0)throw Error('Shared qualification deadline exhausted');
 assertLegalFileIdentity(identity);const output=execFileSync(python,['-I','-S','-B','-c',code],{input:request,maxBuffer:META,timeout:Math.max(1,Math.floor(remaining)),env:{PATH:'/usr/bin:/bin',LANG:'C'}});
 assertLegalFileIdentity(identity);input.budget.check();input.guard();return output;
}
