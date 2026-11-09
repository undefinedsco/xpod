import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {observeCandidateServiceBun142Runtime,observeOfficialBun142Runtime} from '../../scripts/lib/independent-admission/legal-bun-runtime';
/** The issuer's documented reservation maximum for this fixed target:
 *   cold acquisition -> the fixed 64MiB SERVICE_TARGET_MAXIMUM
 *   held cached ZIP  -> that ZIP's exact size plus the 8192-byte checksum headroom
 * (`legal-bun-runtime.ts:123-127`). The fixture asserts the REAL contract value
 * for whichever case the checkout is in, instead of a single hardcoded constant
 * that silently assumed no authenticated ZIP was present. */
function expectedReservationMaximum(){
 const zip=path.resolve('.test-data/legal-bun-runtime/bun-darwin-aarch64.zip.90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f.original.zip');
 try{const size=fs.statSync(zip).size;if(size>0)return size+8192;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 return 64*1024**2;
}
async function run(input:{remaining?:number;reserve?:()=>object;legacy?:boolean;revokeAfterReserve?:boolean}){
 const prior=globalThis.fetch;let requests=0,reservations=0,settlements=0;
 const expectedMaximum=expectedReservationMaximum();
 globalThis.fetch=(async()=>{requests++;throw Error('fixed test transport rejection');}) as typeof fetch;
 const parent={check(){if(input.revokeAfterReserve&&reservations)throw Error('revoked shared parent');},remainingMs:()=>input.remaining??3000,reserveOriginalMaximum(n:number){expect(n).toBe(expectedMaximum);reservations++;return input.reserve?input.reserve():{};},settleOriginalReservation(){settlements++;}};
 try{if(input.legacy){try{await observeOfficialBun142Runtime('darwin-arm64');}catch{/* Cold legacy acquisition is deliberately denied; an existing real legacy cap may be reused. */}}const before=requests;await expect(observeCandidateServiceBun142Runtime('darwin-arm64',parent)).rejects.toThrow();return {requests:requests-before,reservations,settlements};}finally{globalThis.fetch=prior;}
}
test('service reserve failure precedes network and is not settled',async()=>{expect(await run({reserve(){throw Error('parent full');}})).toEqual({requests:0,reservations:1,settlements:0});});
test('expired shared deadline precedes reservation and network',async()=>{expect(await run({remaining:0})).toEqual({requests:0,reservations:0,settlements:0});});
test('missing actual reservation token rejects before network',async()=>{expect(await run({reserve:()=>undefined as any})).toEqual({requests:0,reservations:1,settlements:0});});
test('legacy observation does not bypass service reservation',async()=>{expect(await run({legacy:true,reserve(){throw Error('parent full');}})).toEqual({requests:0,reservations:1,settlements:0});});
test('revoked parent after reservation keeps entire ceiling charged',async()=>{expect(await run({revokeAfterReserve:true})).toEqual({requests:0,reservations:1,settlements:0});});
