import {test,expect} from 'bun:test';
import {createCandidateServiceQualificationBudget} from '../../scripts/lib/independent-admission/candidate-service-qualification-budget';
import limits from '../../scripts/lib/module-artifact-limits.json';
test('all receiver axes consume the same logical read counter without replenishment',()=>{
 const shared=createCandidateServiceQualificationBudget(),source=shared,legal=shared,abi=shared;
 source.chargeReadBytes(limits.sourceMaterialBytes-64);legal.chargeReadBytes(32);expect(abi.remainingReadBytes()).toBe(32);abi.chargeReadBytes(32);expect(source.remainingReadBytes()).toBe(0);
 expect(()=>legal.chargeReadBytes(1)).toThrow('shared logical read bound exceeded');expect(()=>source.check()).toThrow('shared logical read bound exceeded');expect(shared.remainingMs()).toBe(0);
});
test('material reservation and logical IO are distinct bounded resources',()=>{
 const shared=createCandidateServiceQualificationBudget();shared.reserveBytes(limits.sourceMaterialBytes);expect(shared.remainingReadBytes()).toBe(limits.sourceMaterialBytes);shared.chargeReadBytes(64);expect(shared.remainingReadBytes()).toBe(limits.sourceMaterialBytes-64);
 expect(()=>shared.reserveBytes(1)).toThrow('shared material reservation bound exceeded');expect(()=>shared.chargeReadBytes(0)).toThrow('shared material reservation bound exceeded');
});
test('invalid byte charges cannot decrease or replenish shared counters',()=>{
 for(const bytes of [-1,NaN,Infinity,0.5,Number.MAX_SAFE_INTEGER+1]){
  const shared=createCandidateServiceQualificationBudget();expect(()=>shared.chargeReadBytes(bytes)).toThrow();expect(()=>shared.check()).toThrow();
 }
});

test('physical reservations require a genuine retained original universe',()=>{
 expect(()=>createCandidateServiceQualificationBudget({})).toThrow('genuine service original universe required');
 const shared=createCandidateServiceQualificationBudget();
 expect(()=>shared.reserveOriginalMaximum(0)).toThrow('genuine service original universe required');
 expect(()=>shared.check()).toThrow('genuine service original universe required');
});
