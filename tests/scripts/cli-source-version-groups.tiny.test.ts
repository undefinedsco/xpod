import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {CLI_SOURCE_POLICY,CLI_SOURCE_VERSION_GROUPS,reviewedCliSourceVersion} from '../../scripts/lib/independent-admission/source-rules';
const files={producer:'scripts/check-cli-publication.cjs',publicationBudget:'scripts/lib/cli-publication-budget.cjs',sourceHelper:'scripts/lib/module-source-materials.py',sourceLimits:'scripts/lib/module-artifact-limits.json',copier:'scripts/cli-build-inputs.cjs',supervisor:'scripts/lib/afs-publication-command.cjs',workflow:'.github/workflows/cli-package.yml'};
const actual=Object.fromEntries(Object.entries(files).map(([key,file])=>[key,createHash('sha256').update(readFileSync(file)).digest('hex')])) as Record<keyof typeof CLI_SOURCE_POLICY,string>;
test('actual callback source helper belongs to the complete current CLI tuple',()=>{expect(reviewedCliSourceVersion(actual)).toBe(true);expect(actual.sourceHelper).toBe('07dbfc5531b7b3b812fe6f532141c964255b90f46ed30a05c86f6e42ef2e0ee5');for(const key of Object.keys(files) as (keyof typeof CLI_SOURCE_POLICY)[])expect(reviewedCliSourceVersion({...actual,[key]:'0'.repeat(64)})).toBe(false);});
test('preserves every historical reviewed combination without lending it the new helper',()=>{const old=CLI_SOURCE_VERSION_GROUPS[0]!;for(const supervisor of old.supervisors)for(const workflow of old.workflows)expect(reviewedCliSourceVersion({...CLI_SOURCE_POLICY,supervisor,workflow})).toBe(true);expect(reviewedCliSourceVersion({...actual,workflow:'c856baf24a28fe789db1e80c26e7b69b7e4e08bd0923f52ce376840ac885c1eb'})).toBe(false);expect(reviewedCliSourceVersion({...actual,supervisor:CLI_SOURCE_POLICY.supervisor})).toBe(false);});

test('keeps the prior callback tuple exact',()=>{expect(reviewedCliSourceVersion({...actual,sourceHelper:'c28f194ca9767f2aeddd9cff6f633dac2280ae9c4e5d716d3273706afce81850'})).toBe(true);});
