import {expect,it} from 'vitest';
import {inspectSdkToolchainInputRequirements} from '../../scripts/lib/independent-admission/qlever-sdk-toolchain-inputs';
// Raw protocol fixture only: no SDK/source capability or execution authority.
function fixture() {
 const records:any[]=[
  {kind:'kernel-syscall',op:'entry',pid:10,arch:0xc000003e,nr:59,args:[1,2,3,0,0,0]},
  {kind:'ptrace-event',event:4,pid:10},
  {kind:'kernel-syscall',op:'entry',pid:10,arch:0xc000003e,nr:9,args:[0,4096,5,2,3,0]},
  {kind:'kernel-syscall',op:'exit',pid:10,entrySequence:3,result:4096,isError:false},
  {kind:'actual-wait-exit',pid:10,returnCode:0},
 ];
 return records.map((row,index)=>({path:'inner/toolchain-execution/compile.trace-0000.jsonl',line:index+1,bytes:Buffer.from(JSON.stringify({...row,phase:'compile',sequence:index+1})+'\n')}));
}
it('derives actual exec-stop and mapping obligations without granting source closure',()=>{
 const report=inspectSdkToolchainInputRequirements(fixture(),()=>{});
 expect(report.executions).toHaveLength(1);expect(report.executions[0]?.entrySequence).toBe(1);
 expect(report.mappings[0]).toMatchObject({fd:3,length:4096,protection:5,exitSequence:4,returnedAddressHex:'1000'});
 expect(report.toolchainSourceClosureVerified).toBe(false);expect(report.pending).toHaveLength(3);
});
it('rejects missing actual exec entry, truncated universe and fabricated successful syscall',()=>{
 for(const mutate of [
  (rows:ReturnType<typeof fixture>)=>rows.splice(0,1),
  (rows:ReturnType<typeof fixture>)=>rows.splice(3),
  (rows:ReturnType<typeof fixture>)=>{const row=JSON.parse(rows[1]!.bytes.toString());row.kind='kernel-syscall';row.op='exit';row.entrySequence=1;row.result=0;row.isError=false;rows[1]!.bytes=Buffer.from(JSON.stringify(row)+'\n');},
 ]){const rows=fixture();mutate(rows);expect(()=>inspectSdkToolchainInputRequirements(rows,()=>{})).toThrow();}
});
it('never uses self-reported tool/version metadata as execution evidence',()=>{
 const bytes=Buffer.from(JSON.stringify({sequence:1,phase:'compile',kind:'tool-version',pid:10,path:'/usr/bin/g++',verified:true})+'\n');
 expect(()=>inspectSdkToolchainInputRequirements([{path:'raw',line:1,bytes}],()=>{})).toThrow(/execution universe/);
 expect(()=>inspectSdkToolchainInputRequirements(fixture(),()=>{throw Error('expired');})).toThrow('expired');
});

it('treats MAP_ANONYMOUS with a nonnegative FD as anonymous and includes pkey_mprotect',()=>{
 const rows=fixture();const mmap=JSON.parse(rows[2]!.bytes.toString());mmap.args[3]=0x22;rows[2]!.bytes=Buffer.from(JSON.stringify(mmap)+'\n');
 const protection=[{kind:'kernel-syscall',op:'entry',pid:10,arch:0xc000003e,nr:329,args:[4096,4096,5,0,0,0]},{kind:'kernel-syscall',op:'exit',pid:10,entrySequence:5,result:0,isError:false}];
 rows.splice(4,0,...protection.map((row,index)=>({path:'raw',line:index+5,bytes:Buffer.from(JSON.stringify({...row,phase:'compile',sequence:index+5})+'\n')})));
 const final=JSON.parse(rows[6]!.bytes.toString());final.sequence=7;rows[6]!.bytes=Buffer.from(JSON.stringify(final)+'\n');
 const result=inspectSdkToolchainInputRequirements(rows,()=>{});expect(result.mappings).toHaveLength(0);expect(result.anonymousExecutableMappings).toBe(1);expect(result.executableProtectionChanges).toBe(1);expect(result.toolchainSourceClosureVerified).toBe(false);
});
