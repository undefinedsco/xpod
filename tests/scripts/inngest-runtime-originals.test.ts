import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {inspectInngestRuntimeOriginals,observeInstalledInngestRuntime,officialInngestRuntimeObservation,inngestRuntimeAdditionalDurationMs} from '../../scripts/lib/independent-admission/inngest-runtime-originals';
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function fixture(platform='linux',arch='x64'){
 const target=platform+'-'+arch,sourceSha='a'.repeat(40),sha='b'.repeat(64),originals=new Map<string,Buffer>();
 const product:any={package:'@undefineds.co/xpod-api-'+target,target,sourceSha,version:'1.2.3'},productMembers=[{path:'node_modules/inngest-cli/bin/inngest',bytes:128,sha256:sha,mode:0o755}];
 const result:any={records:[],installedVerification:{}};
 function put(name:string,body:Buffer){originals.set(name,body);return {path:name,bytes:body.length,sha256:hash(body)};}
 for(const runtime of ['node','bun']){
  const cycle='/owned/'+runtime,home=cycle+'/home',binary=home+'/.xpod/modules/api/'+target+'/1.2.3/package/node_modules/inngest-cli/bin/inngest',prefix=['/usr/bin/fixed-source-denial'];
  const loader=platform==='linux'?{format:'elf64',interpreter:false,neededLibraries:[]}:{format:'macho64',libraries:['/usr/lib/libSystem.B.dylib'],minimumOS:[12,0,0]};
  const before={path:binary,bytes:128,sha256:sha,identity:{st_dev:'1',st_ino:'2',st_size:'128',st_mode:String(0o100755),st_nlink:'1',st_mtime_ns:'100000000000000001',st_ctime_ns:'100000000000000001'},loader};
  result.records.push({label:runtime+'-runtime-target',argv:[...prefix,'/node','-e','fixed actual target']});
  function command(label:string,args:string[],stdout:string){const name=runtime+'-'+label;result.records.push({label:name,argv:[...prefix,...args],status:'passed',returncode:0,waitStatus:'known',rawClosed:true,rawClosedBeforeHash:true,rawEligible:true,ownedGroupAbsent:true,rawHandlesClosed:true,raw:[{...put(name+'.stdout.raw.log',Buffer.from(stdout)),sizeIsFinal:true},{...put(name+'.stderr.raw.log',Buffer.alloc(0)),sizeIsFinal:true}]});}
  command('inngest-version',[binary,'version'],'1.40.0-0d75b0b\n');
  if(platform==='darwin')command('inngest-loader',['/usr/bin/otool','-L',binary],binary+':\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1345.100.2)\n');
  const metadata={schemaVersion:1,kind:'installed-inngest-version-runtime-originals',sourceSha,target,runtime,host:{platform,arch,release:'actual kernel'},before,after:structuredClone(before),versionCommandLabel:runtime+'-inngest-version',loaderCommandLabel:platform==='darwin'?runtime+'-inngest-loader':null,environment:{HOME:home,TMPDIR:cycle,PATH:cycle+'/runtime-bin:/usr/bin:/bin',LANG:'en_US.UTF-8',DO_NOT_TRACK:'1'}};
  result.installedVerification[runtime]={actualRuntimeTarget:{platform,arch},inngestRuntimeOriginal:put(runtime+'-inngest-runtime.original.json',Buffer.from(JSON.stringify(metadata)))};
 }
 const input={product,productMembers,result,readOriginal:(name:string,maximum:number)=>{const b=originals.get(name)!;if(!b||b.length>maximum)throw Error('missing bounded original');return b;}};
 function metadata(runtime:string,change:(value:any)=>void){const name=runtime+'-inngest-runtime.original.json',v=JSON.parse(originals.get(name)!.toString());change(v);result.installedVerification[runtime].inngestRuntimeOriginal=put(name,Buffer.from(JSON.stringify(v)));}
 return {input,originals,metadata};
}
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
