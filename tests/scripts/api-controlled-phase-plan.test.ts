import {describe,it,expect} from 'vitest';
import {reviewedModulePhasePlan} from '../../scripts/lib/independent-admission/module-source-phases';
describe('one reviewed API parent recipe',()=>{
 it('projects both historical official and explicit controlled plans without executing candidate paths',()=>{
  const old=reviewedModulePhasePlan('api','/nonexistent/candidate','/nonexistent/output','1.2.3','linux-arm64');
  const controlled=reviewedModulePhasePlan('api','/nonexistent/candidate','/nonexistent/output','1.2.3','linux-arm64',{sourceKind:'xpod-controlled-inngest-build-v1',retainedByteCeiling:1000000000});
  expect(old).toHaveLength(11);expect(controlled).toHaveLength(20);
  expect(controlled.find(row=>row.name==='inngest-controlled-acquire')!.command).toEqual(['/usr/bin/python3','-I','-S','-B','/nonexistent/candidate/scripts/lib/inngest-controlled-build.py','acquire','/nonexistent/output/controlled-inngest-work','--retained-byte-ceiling','1000000000']);
  expect(controlled.some(row=>row.name==='native-material'||row.name==='native-inputs')).toBe(false);
 });
 it('rejects unsupported source kinds, targets and expanded retained budgets',()=>{
  for(const value of [{sourceKind:'other',retainedByteCeiling:1},{sourceKind:'xpod-controlled-inngest-build-v1',retainedByteCeiling:4294967297}])expect(()=>reviewedModulePhasePlan('api','/r','/o','1.2.3','linux-arm64',value)).toThrow();
  expect(()=>reviewedModulePhasePlan('api','/r','/o','1.2.3','darwin-arm64',{sourceKind:'xpod-controlled-inngest-build-v1',retainedByteCeiling:1})).toThrow();
 });
});
