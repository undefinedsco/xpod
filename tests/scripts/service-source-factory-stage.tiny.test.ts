/**
 * V3-F2 — factory reachability must be stated truthfully.
 *
 * V2 claimed the real factory "advances past the origin partition to a genuine
 * capability prerequisite", but the message it asserted is produced by
 * `bindHandles`, the FIRST step after the budget, long before the partition.
 * This test pins the ACTUAL stage so the claim can never drift again.
 */
import {test,expect} from 'bun:test';
import {createCandidateServiceSourceQualification} from '../../scripts/lib/independent-admission/candidate-service-source-qualification';

const budget:any={check(){},remainingMs:()=>600000,reserveBytes(){},chargeReadBytes(){},
  remainingReadBytes:()=>1e9,remainingOriginalBytes:()=>1e9,
  reserveOriginalMaximum(){return Object.freeze({});},settleOriginalReservation(){}};

async function stageOf(input:Record<string,unknown>):Promise<string>{
  try{
    await createCandidateServiceSourceQualification({...input,runtimeArtifact:undefined,replay:{},pack:{},
      materialized:{},materializedInput:{},nativeContext:{},budget} as any);
    return 'RESOLVED';
  }catch(error){return String((error as Error).message);}
}

test('the factory stops at bindHandles for non-capabilities, which is the FIRST stage',async()=>{
  const message=await stageOf({originals:{},source:{},sdk:{}});
  expect(message).toContain('same issued native/original/source/SDK handles required');
  // No partition/runtime-range code can have run at this point.
  expect(message.includes('bounded runtime range')).toBe(false);
  expect(message.includes('streamMemberDigest')).toBe(false);
  expect(message.includes('outside both declared roots')).toBe(false);
  expect(message.includes('left uncovered')).toBe(false);
},60000);

test('the reported stage is bindHandles, not the partition, for every non-capability shape',async()=>{
  for(const input of [{},{originals:{},source:{},sdk:{}},{originals:{},source:{},sdk:{},nativeContext:{}}]){
    const message=await stageOf(input as any);
    expect(message).toContain('same issued native/original/source/SDK handles required');
  }
},60000);
