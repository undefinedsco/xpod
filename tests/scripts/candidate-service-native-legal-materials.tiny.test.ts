import {test,expect} from 'bun:test';
import {candidateServiceNativeLegalMaterials} from '../../scripts/lib/independent-admission/candidate-service-native-legal-materials';
test('native legal archive adapter rejects structural or copied handles before reading',()=>{
 let charged=0;const handle={verified:true,sourceArchives:[],readSourceArchiveRange(){throw Error('untrusted reader reached');}};
 expect(()=>candidateServiceNativeLegalMaterials({serviceOriginals:{},source:{},runtimeArtifact:{},nativeContext:{qualification:handle,originals:{},sdkOriginals:{},sdkAdmission:{}},budget:{remainingMs(){return 1000;},remainingReadBytes(){return 100000;},reserveBytes(){},check(){},chargeReadBytes(n){charged+=n;}}})).toThrow('issued candidate service originals required');
 expect(charged).toBe(0);
});
test('shared parent cancellation propagates without entering native archive reads',()=>{
 const stop=Error('parent deadline');let observed:unknown;
 try{candidateServiceNativeLegalMaterials({serviceOriginals:{},source:{},runtimeArtifact:{},nativeContext:{qualification:{},originals:{},sdkOriginals:{},sdkAdmission:{}},budget:{remainingMs(){return 1000;},remainingReadBytes(){return 100000;},reserveBytes(){},check(){throw stop;},chargeReadBytes(){throw Error('read reached');}}});}catch(error){observed=error;}
 expect(observed).toBe(stop);
});
