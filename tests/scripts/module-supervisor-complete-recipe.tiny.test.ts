import{test,expect}from'bun:test';import fs from'node:fs';import{execFileSync}from'node:child_process';import path from'node:path';
import{reviewedModuleSupervisorSource as inspect}from'../../scripts/lib/independent-admission/module-source-phases';
const root=path.resolve(import.meta.dirname,'../..'),supervisor='scripts/agentfs-native-ci/supervise.py';
test('opt-in supervisor requires each module current complete producer/materials/limits tuple; legacy check stays compatible',()=>{
 const actual=(name:string)=>fs.readFileSync(path.join(root,name)),legacy=execFileSync('git',['show','4dc6b778a808350613d0f1ae0ffc9444b55697ce:'+supervisor],{cwd:root});
 for(const module of['api','css','afs']as const){expect(inspect(module,actual)).toBe(true);expect(inspect(module,name=>name===supervisor?legacy:actual(name))).toBe(true);
  for(const changed of['scripts/'+module+'-module-producer.py','scripts/lib/module-source-materials.py','scripts/lib/module-artifact-limits.json',supervisor])expect(inspect(module,name=>name===changed?Buffer.from('mixed or unreviewed'):actual(name))).toBe(false);
 }
});
