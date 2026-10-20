import{test,expect}from'bun:test';import fs from'node:fs';import{createHash}from'node:crypto';import path from'node:path';
import{reviewedModuleSupervisorSource as inspect}from'../../scripts/lib/independent-admission/module-source-phases';
const root=path.resolve(import.meta.dirname,'../..'),supervisor='scripts/agentfs-native-ci/supervise.py';
test('opt-in supervisor requires each module current complete producer/materials/limits tuple; legacy check stays compatible',()=>{
 const actual=(name:string)=>fs.readFileSync(path.join(root,name)),legacy=actual('tests/fixtures/module-supervisor-legacy.original.py');
 // Exact historical bytes remain available in shallow checkouts and source archives.
 expect(createHash('sha256').update(legacy).digest('hex')).toBe('49fd9c7a7a9c9dc1612b1261f0cbc218166f48487df726239437ae9ad98ba407');
 for(const module of['api','css','afs']as const){expect(inspect(module,actual)).toBe(true);expect(inspect(module,name=>name===supervisor?legacy:actual(name))).toBe(true);
  for(const changed of['scripts/'+module+'-module-producer.py','scripts/lib/module-source-materials.py','scripts/lib/module-artifact-limits.json',supervisor])expect(inspect(module,name=>name===changed?Buffer.from('mixed or unreviewed'):actual(name))).toBe(false);
 }
});
