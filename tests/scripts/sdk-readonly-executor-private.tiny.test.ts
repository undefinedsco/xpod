import {test,expect} from 'bun:test';
import {observeQleverSdkReadOnlyExecutor} from '../../scripts/lib/independent-admission/qlever-sdk-readonly-executor';
test('serialized SDK/source/execution-shaped data cannot issue readonly executor facts or trigger acquisition',async()=>{
 let calls=0;const previous=globalThis.fetch;globalThis.fetch=(async()=>{calls++;throw Error('network forbidden');}) as typeof fetch;
 try{
  for(const value of [undefined,{},JSON.parse(JSON.stringify({sdkReadOnlyExecutorOriginalsVerified:true,sourceSha:'a'.repeat(40),facts:{sdkActualConfigureCompileTrackedWaitVerified:true},master:{readonlyExecutor:{path:'readonly-executor/collection.json'}}}))]){
   const result=await observeQleverSdkReadOnlyExecutor({sdkOriginals:value,source:value});expect(result.facts).toEqual({});expect(result.pending).toContain('qlever-sdk-readonly-executor-private-sdk-source-handles-unavailable');
  }
  expect(calls).toBe(0);
 }finally{globalThis.fetch=previous;}
});
