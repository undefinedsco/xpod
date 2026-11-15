import {execFileSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {captureLegalFileIdentity,assertLegalFileIdentity,resolveExecutableIdentityPath} from './legal-file-custody';
/** Reuse the sole Python declarations parser and shared smoke replay. This
 * mechanism issues no source, actual-process-wait or release qualification. */
const worker=String.raw`
import base64,json,sys,types
raw=sys.stdin.buffer.read(4*1024**2+1)
if len(raw)>4*1024**2:raise ValueError('bounded replay input required')
request=json.loads(raw)
if set(request)!={'sources','protocol'}:raise ValueError('exact replay request')
def body(value):
 if not isinstance(value,str):raise ValueError('encoded original required')
 data=base64.b64decode(value,validate=True)
 if len(data)>1024**2:raise ValueError('bounded original required')
 return data
sources={key:body(value) for key,value in request['sources'].items()}
if set(sources)!={'header','adapter','runtime','client','declarations','helper','replay'}:raise ValueError('exact source closure required')
protocol={key:body(value) for key,value in request['protocol'].items()}
if set(protocol)!={'stdin','stdout','stderr'} or sum(map(len,protocol.values()))>1024**2:raise ValueError('bounded complete protocol required')
def module(role):
 value=types.ModuleType('reviewed_abi_'+role)
 value.__file__='reviewed-'+role+'.py'
 exec(compile(sources[role],value.__file__,'exec'),value.__dict__)
 return value
declarations,helper,replay=map(module,('declarations','helper','replay'))
expected=declarations.declarations(*(sources[key] for key in ('header','adapter','runtime','client')))
observed=replay.replay_shared_smoke(helper,protocol['stdin'],protocol['stdout'],protocol['stderr'],expected,lambda:None)
sys.stdout.write(json.dumps(dict(expectedAbi=expected,replay=observed),sort_keys=True)+'\n')
`;
const sourceRoles=['header','adapter','runtime','client','declarations','helper','replay'] as const;
type SourceRole=typeof sourceRoles[number];
function need(value:unknown,why:string):asserts value {if(!value)throw Error('Service ABI replay: '+why);}
export function replayCandidateServiceAbiProtocol(input:{sources:Readonly<Record<SourceRole,Buffer>>;protocol:Readonly<Record<'stdin'|'stdout'|'stderr',Buffer>>;remainingMs:()=>number;assertCurrent:()=>void}) {
 input.assertCurrent();
 need(Object.keys(input.sources).sort().join(',')===[...sourceRoles].sort().join(','),'exact source closure required');
 need(Object.keys(input.protocol).sort().join(',')==='stderr,stdin,stdout','exact protocol originals required');
 const encode=(rows:Readonly<Record<string,Buffer>>)=>Object.fromEntries(Object.entries(rows).map(([key,value])=>{need(Buffer.isBuffer(value)&&value.length<=1024**2,'bounded complete original required');return[key,value.toString('base64')];}));
 need(Object.values(input.protocol).reduce((sum,value)=>sum+value.length,0)<=1024**2,'same combined protocol ceiling required');
 const request=Buffer.from(JSON.stringify({sources:encode(input.sources),protocol:encode(input.protocol)}));need(request.length<=4*1024**2,'same metadata request ceiling required');
 const remaining=input.remainingMs();need(Number.isFinite(remaining)&&remaining>0,'original remaining parent window required');
 const deadline=performance.now()+remaining;
 const python=resolveExecutableIdentityPath('/usr/bin/python3'),pythonIdentity=captureLegalFileIdentity(python);
 input.assertCurrent();assertLegalFileIdentity(pythonIdentity);
 const timeout=deadline-performance.now();need(timeout>0,'original parent window exhausted before replay');
 const raw=execFileSync(python,['-I','-S','-B','-c',worker],{input:request,maxBuffer:1024**2,timeout:Math.max(1,Math.floor(timeout)),env:{PATH:'/usr/bin:/bin',LANG:'C'}});
 assertLegalFileIdentity(pythonIdentity);need(performance.now()<=deadline&&input.remainingMs()>0,'original parent window exhausted');input.assertCurrent();
 return Object.freeze(JSON.parse(raw.toString()) as {expectedAbi:Readonly<Record<string,number>>;replay:Readonly<Record<string,unknown>>});
}
