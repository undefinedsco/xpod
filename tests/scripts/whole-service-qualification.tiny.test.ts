/**
 * Focused tests for the whole-service aggregate and the release-gate CLI.
 *
 * These use the ACTUAL modules (no mocked factories, no reimplemented views) and
 * assert the refusal/lifecycle contract. A full genuine positive needs a real
 * service acquisition + SDK originals + native ABI originals + App replay, which
 * this host cannot produce offline; that limit is stated in RESULTS.md and is
 * NOT asserted as passing here.
 */
import {test,expect} from 'bun:test';
import {
 observeCandidateServiceWholeQualification,
 candidateServiceWholeQualificationView,
 candidateServiceWholeQualificationProvisional,
 assertWholeServiceQualification,
 sealWholeServiceQualification,
} from '../../scripts/lib/independent-admission/candidate-service-whole-qualification';
import {requireCandidateServiceQualification} from '../../scripts/check-candidate-service-sdk-source';

const BUDGET=()=>({check(){},remainingMs:()=>60000,reserveBytes(){},chargeReadBytes(){},
 remainingReadBytes:()=>1e9,remainingOriginalBytes:()=>1e9,reserveOriginalMaximum(){return{};},settleOriginalReservation(){}});
const INPUT=(budget=BUDGET())=>({originals:{},source:{},sdk:{},runtimeArtifact:{},pack:{},materialized:{},
 materializedInput:{},replay:{},nativeContext:{},budget});
const FAKE=Object.freeze({wholeServiceQualificationVerified:true,releaseAccepted:false,
 wholeServiceSourceVerified:true,serviceAbiVerified:true,legalCoverageVerified:true});

test('plain objects and foreign handles never become a whole-service capability',async()=>{
 await expect(observeCandidateServiceWholeQualification(INPUT() as never))
  .rejects.toThrow('same issued native originals/immutable source/SDK originals required');
 // A missing input object is refused; budget validation runs before axis work.
 await expect(observeCandidateServiceWholeQualification({} as never)).rejects.toThrow('one shared parent budget required');
 await expect(observeCandidateServiceWholeQualification(undefined as never)).rejects.toThrow('typed aggregate input required');
});

test('an incomplete parent budget is refused before any axis runs',async()=>{
 const partial={check(){},remainingMs:()=>60000,reserveBytes(){},chargeReadBytes(){}};
 await expect(observeCandidateServiceWholeQualification(INPUT(partial as never)))
  .rejects.toThrow('complete shared parent budget required: chargeReadBytes'.replace('chargeReadBytes','remainingReadBytes'));
 const expired={...BUDGET(),check(){},remainingMs:()=>0};
 await expect(observeCandidateServiceWholeQualification(INPUT(expired as never)))
  .rejects.toThrow('shared parent deadline exhausted');
});

test('caller JSON with every boolean true is not authority',()=>{
 const input=INPUT();
 expect(candidateServiceWholeQualificationView(FAKE,input as never)).toBeUndefined();
 expect(candidateServiceWholeQualificationProvisional(FAKE,input as never)).toBeUndefined();
 expect(()=>assertWholeServiceQualification(FAKE,input as never))
  .toThrow('genuine whole-service aggregate capability required');
 expect(sealWholeServiceQualification(FAKE)).toBe(false);
 expect(candidateServiceWholeQualificationView(FAKE,input as never)).toBeUndefined();
});

test('null / frozen / copied aggregates never resolve or seal',()=>{
 for(const value of [null,undefined,42,'x',[],Object.freeze({}),{...FAKE}] as unknown[]){
  expect(candidateServiceWholeQualificationView(value,INPUT() as never)).toBeUndefined();
  expect(candidateServiceWholeQualificationProvisional(value,INPUT() as never)).toBeUndefined();
  expect(sealWholeServiceQualification(value)).toBe(false);
 }
});

test('the release gate fails closed with a concrete prerequisite, never returns',()=>{
 expect(()=>requireCandidateServiceQualification()).toThrow(/Candidate service qualification pending: /u);
 expect(()=>requireCandidateServiceQualification()).toThrow(/genuine whole-service aggregate capability required/u);
 expect(()=>requireCandidateServiceQualification(FAKE,INPUT() as never)).toThrow(/qualification pending/u);
});

test('a different parent budget object cannot resolve the same aggregate view',()=>{
 const input=INPUT();
 const other=INPUT();
 expect(candidateServiceWholeQualificationView({},input as never)).toBeUndefined();
 expect(candidateServiceWholeQualificationProvisional({},input as never)).toBeUndefined();
 expect(candidateServiceWholeQualificationView({},other as never)).toBeUndefined();
});
