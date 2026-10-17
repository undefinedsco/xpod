import {test,expect} from 'bun:test';
import {observeAfsConsumerRuntimeOriginals} from '../../scripts/lib/independent-admission/afs-consumer-runtime-originals';
test('invalid target cannot reach the official runtime transport',async()=>{
 const previous=globalThis.fetch;let calls=0;globalThis.fetch=(async()=>{calls++;throw Error('must not fetch');}) as typeof fetch;
 try{await expect(observeAfsConsumerRuntimeOriginals('portable','prepublish')).rejects.toThrow('Canonical AFS runtime target required');expect(calls).toBe(0);}finally{globalThis.fetch=previous;}
});
