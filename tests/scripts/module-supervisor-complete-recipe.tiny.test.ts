import{test,expect}from'bun:test';import fs from'node:fs';import{createHash}from'node:crypto';import path from'node:path';
import{reviewedModuleSupervisorSource as inspect}from'../../scripts/lib/independent-admission/module-source-phases';
import prior from '../fixtures/independent-admission/pre-sdk47-api-originals.original.json';
const root=path.resolve(import.meta.dirname,'../..'),supervisor='scripts/agentfs-native-ci/supervise.py';
test('opt-in supervisor requires each module current complete producer/materials/limits tuple; legacy check stays compatible',()=>{
 const actual=(name:string)=>fs.readFileSync(path.join(root,name)),legacy=actual('tests/fixtures/module-supervisor-legacy.original.py');
 // Exact historical bytes remain available in shallow checkouts and source archives.
 expect(createHash('sha256').update(legacy).digest('hex')).toBe('49fd9c7a7a9c9dc1612b1261f0cbc218166f48487df726239437ae9ad98ba407');
 for(const module of['api','css','afs']as const){expect(inspect(module,actual)).toBe(true);expect(inspect(module,name=>name===supervisor?legacy:actual(name))).toBe(true);
  const materials=prior.files.find(row=>row.path==='scripts/lib/module-source-materials.py')!;
  const retained=Buffer.from(materials.rawBase64,'base64');
  expect(createHash('sha256').update(retained).digest('hex')).toBe(materials.sha256);
  expect(inspect(module,name=>name===materials.path?retained:actual(name))).toBe(true);
  for(const changed of['scripts/'+module+'-module-producer.py','scripts/lib/module-source-materials.py','scripts/lib/module-artifact-limits.json',supervisor])expect(inspect(module,name=>name===changed?Buffer.from('mixed or unreviewed'):actual(name))).toBe(false);
 }
});

test('CSS metadata revalidation preserves the exact prior producer and its opt-in supervisor tuples',()=>{
 const producer='scripts/css-module-producer.py',prior=fs.readFileSync(path.join(root,'tests/fixtures/independent-admission/css-producer-pre-freshness.original.py'));
 expect(createHash('sha256').update(prior).digest('hex')).toBe('78e2ec3c272233602083f81d574cfefc5f6c36e9200c1d92e6f7935bd6cac41f');
 const actual=(name:string)=>fs.readFileSync(path.join(root,name));
 expect(inspect('css',name=>name===producer?prior:actual(name))).toBe(true);
 expect(inspect('css',name=>name===producer?Buffer.from('unreviewed CSS producer'):actual(name))).toBe(false);
});
