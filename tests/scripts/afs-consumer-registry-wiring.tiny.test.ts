import {test,expect} from 'bun:test';
import {observeAfsConsumerVerifierRegistryOriginals} from '../../scripts/lib/independent-admission/afs-consumer-registry-originals';
const input:any={stage:'prepublish',sourceSha:'a'.repeat(40),target:'linux-x64',product:{package:'@undefineds.co/xpod-afs-linux-x64',sourceSha:'a'.repeat(40),target:'linux-x64'},tools:[],productMembers:[],originals:[],readOriginal:()=>Buffer.from('{}'),readOriginalRange:()=>Buffer.alloc(0)};
test('metadata claims without actual tool tar/private source never trigger official registry requests',async()=>{
 const previous=globalThis.fetch;let calls=0;globalThis.fetch=(async()=>{calls++;throw Error('must not fetch');}) as typeof fetch;
 try{await expect(observeAfsConsumerVerifierRegistryOriginals({...input,source:{trusted:true}})).rejects.toThrow('plan pending');expect(calls).toBe(0);
 await expect(observeAfsConsumerVerifierRegistryOriginals(input,Date.now()-1)).rejects.toThrow('deadline pending');expect(calls).toBe(0);
 }finally{globalThis.fetch=previous;}
});
