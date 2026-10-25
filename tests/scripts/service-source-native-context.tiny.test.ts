import {test,expect} from 'bun:test';
import {bindCandidateServiceNativeSource} from '../../scripts/lib/independent-admission/candidate-service-source-native-context';
test('native source context cannot be made from structural or copied handles',()=>{
 const identity={sourceSha:'a'.repeat(40),runId:1,runAttempt:1};
 for(const value of [{},{verified:true,identity},JSON.parse(JSON.stringify({verified:true,identity}))]){
  expect(()=>bindCandidateServiceNativeSource({serviceOriginals:value,source:value,runtimeArtifact:value,nativeContext:{qualification:value,originals:value,sdkOriginals:value,sdkAdmission:value},budget:{check(){}}})).toThrow();
 }
});
test('native source context shares the caller deadline before private reads',()=>{
 expect(()=>bindCandidateServiceNativeSource({serviceOriginals:{},source:{},runtimeArtifact:{},nativeContext:{qualification:{},originals:{},sdkOriginals:{},sdkAdmission:{}},budget:{check(){throw Error('parent expired');}}})).toThrow('parent expired');
});
