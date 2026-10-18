import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {inspectInngestRuntimeOriginals,observeInstalledInngestRuntime,officialInngestRuntimeObservation,inngestRuntimeAdditionalDurationMs} from '../../scripts/lib/independent-admission/inngest-runtime-originals';
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
import {runtimeFixture as fixture} from '../fixtures/independent-admission/inngest-runtime-protocol';

it('validates actual command/dual raw and loader originals for both profiles without granting source/toolchain',()=>{
 for(const platform of ['linux','darwin'])for(const arch of ['x64','arm64']){const report=inspectInngestRuntimeOriginals(fixture(platform,arch).input);expect(report.inngestInstalledVersionExecutionVerified).toBe(true);expect(report.observations).toHaveLength(2);expect(report.toolchainSourceClosureVerified).toBe(false);expect(report.fullNativeSourceClosureVerified).toBe(false);}
 expect(inngestRuntimeAdditionalDurationMs).toBe(240000);
});
it('rejects changed binary/host/env, fake version argv/stdout, missing profile/raw and unknown process closure',()=>{
 for(const change of [
  (x:ReturnType<typeof fixture>)=>x.metadata('node',v=>{v.after.sha256='c'.repeat(64);}),
  (x:ReturnType<typeof fixture>)=>x.metadata('node',v=>{v.host.arch='arm64';}),
  (x:ReturnType<typeof fixture>)=>x.metadata('node',v=>{v.environment.DO_NOT_TRACK='';}),
  (x:ReturnType<typeof fixture>)=>x.metadata('node',v=>{v.environment.TOKEN='not permitted';}),
  (x:ReturnType<typeof fixture>)=>{x.input.result.records[1].argv[x.input.result.records[1].argv.length-1]='--version';},
  (x:ReturnType<typeof fixture>)=>{x.input.result.records[1].ownedGroupAbsent=false;},
  (x:ReturnType<typeof fixture>)=>{x.input.result.records[1].raw.pop();},
  (x:ReturnType<typeof fixture>)=>{x.originals.set('node-inngest-version.stdout.raw.log',Buffer.from('1.40.0-wrong\n'));},
  (x:ReturnType<typeof fixture>)=>{delete x.input.result.installedVerification.bun;},
 ]){const x=fixture();change(x);expect(()=>inspectInngestRuntimeOriginals(x.input)).toThrow();}
 const mac=fixture('darwin');mac.metadata('node',v=>{v.before.loader.libraries=['/tmp/fake.dylib'];v.after=structuredClone(v.before);});expect(()=>inspectInngestRuntimeOriginals(mac.input)).toThrow();
});
it('serialized approvals cannot issue or retrieve the official runtime fact',async()=>{
 const value={identity:fixture().input.product,inngestInstalledVersionExecutionVerified:true};expect(officialInngestRuntimeObservation(value)).toBeUndefined();await expect(observeInstalledInngestRuntime({artifact:value,officialReleaseOriginals:value,consumerObservation:value})).rejects.toThrow('same issued');
});

it('keeps selected HTTP communication separate from full ABI and rejects unowned listeners/invalid responses',()=>{
 const x=fixture();
 for(const runtime of ['node','bun'])x.metadata(runtime,v=>{
  const ports=[12345,12346,12347,12348],label=runtime+'-inngest-protocol',prefix=x.input.result.records[0].argv.slice(0,-3);
  const put=(name:string)=>{const bytes=Buffer.alloc(0);x.originals.set(name,bytes);return {path:name,bytes:0,sha256:hash(bytes),sizeIsFinal:true};};
  x.input.result.records.push({label,argv:[...prefix,v.before.path,'dev','--no-discovery','--no-poll','--host','127.0.0.1','--port',String(ports[0]),'--connect-gateway-port',String(ports[1]),'--connect-gateway-grpc-port',String(ports[2]),'--connect-executor-grpc-port',String(ports[3])],status:'passed',returncode:0,waitStatus:'known',rawClosed:true,rawClosedBeforeHash:true,rawEligible:true,ownedGroupAbsent:true,rawHandlesClosed:true,observedGroupMembers:{'42':'actual-start'},raw:[put(label+'.stdout.raw.log'),put(label+'.stderr.raw.log')]});
  const nonce='a'.repeat(32);v.protocol={commandLabel:label,ports,owner:{port:ports[0],pid:42,inode:'123'},event:{name:'xpod/module-native-probe',id:nonce,data:{nonce}},requests:[{method:'GET',path:'/health',status:200,body:'{"status":200,"message":"OK"}'},{method:'POST',path:'/e/xpod-module-probe',status:200,body:'{"ids":["actual-id"],"status":200}'}]};
 });
 const facts=inspectInngestRuntimeOriginals(x.input);expect(facts.inngestInstalledHttpProtocolExecutionVerified).toBe(true);expect(facts.fullRuntimeAbiVerified).toBe(false);expect(facts.toolchainSourceClosureVerified).toBe(false);
 x.metadata('node',v=>{v.protocol.owner.pid=43;});expect(()=>inspectInngestRuntimeOriginals(x.input)).toThrow('actual observed command group');
 x.metadata('node',v=>{v.protocol.owner.pid=42;v.protocol.requests[1].body='{"ids":[],"status":200}';});expect(()=>inspectInngestRuntimeOriginals(x.input)).toThrow('acceptance');
});
