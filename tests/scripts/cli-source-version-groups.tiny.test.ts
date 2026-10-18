import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {CLI_SOURCE_POLICY,CLI_SOURCE_VERSION_GROUPS,reviewedCliSourceVersion,verifyCliInputSet} from '../../scripts/lib/independent-admission/source-rules';
const files={producer:'scripts/check-cli-publication.cjs',publicationBudget:'scripts/lib/cli-publication-budget.cjs',sourceHelper:'scripts/lib/module-source-materials.py',sourceLimits:'scripts/lib/module-artifact-limits.json',copier:'scripts/cli-build-inputs.cjs',supervisor:'scripts/lib/afs-publication-command.cjs',workflow:'.github/workflows/cli-package.yml'};
const actual=Object.fromEntries(Object.entries(files).map(([key,file])=>[key,createHash('sha256').update(readFileSync(file)).digest('hex')])) as Record<keyof typeof CLI_SOURCE_POLICY,string>;
test('actual callback source helper belongs to the complete current CLI tuple',()=>{expect(reviewedCliSourceVersion(actual)).toBe(true);expect(actual.sourceHelper).toBe('b582490cdbbd2b857fa6ce20d0b5d85a73605c90b96063a3c17bf7b38be93601');for(const key of Object.keys(files) as (keyof typeof CLI_SOURCE_POLICY)[])expect(reviewedCliSourceVersion({...actual,[key]:'0'.repeat(64)})).toBe(false);});
test('preserves every historical reviewed combination without lending it the new helper',()=>{const old=CLI_SOURCE_VERSION_GROUPS[0]!;for(const supervisor of old.supervisors)for(const workflow of old.workflows)expect(reviewedCliSourceVersion({...CLI_SOURCE_POLICY,supervisor,workflow})).toBe(true);expect(reviewedCliSourceVersion({...actual,workflow:'c856baf24a28fe789db1e80c26e7b69b7e4e08bd0923f52ce376840ac885c1eb'})).toBe(false);expect(reviewedCliSourceVersion({...actual,supervisor:CLI_SOURCE_POLICY.supervisor})).toBe(false);});

test('keeps the prior callback tuple exact',()=>{expect(reviewedCliSourceVersion({...actual,producer:CLI_SOURCE_POLICY.producer,sourceHelper:'c28f194ca9767f2aeddd9cff6f633dac2280ae9c4e5d716d3273706afce81850'})).toBe(true);});

test('catalog CLI source tuple binds every newly executed catalog original before granting source facts',()=>{
 const current=CLI_SOURCE_VERSION_GROUPS.find(group=>group.producer===actual.producer&&group.sourceHelper===actual.sourceHelper)!;expect(current.sourceBindings?.length).toBe(4);
 for(const binding of current.sourceBindings??[]){expect(createHash('sha256').update(readFileSync(binding.path)).digest('hex')).toBe(binding.sha256);expect(()=>verifyCliInputSet([],{},name=>name===binding.path?Buffer.from('wrong original'):readFileSync(name),[])).toThrow('catalog CLI complete source binding mismatch');}
 expect(reviewedCliSourceVersion({...actual,sourceHelper:'c28f194ca9767f2aeddd9cff6f633dac2280ae9c4e5d716d3273706afce81850'})).toBe(false);
});

test('keeps the precompression catalog helper tuple exact',()=>{expect(reviewedCliSourceVersion({...actual,sourceHelper:'1871c59b9f0bfb4c0ce824123ce9cdc5f472aba11245b5e0eb45c62c4fca42e2'})).toBe(true);});
