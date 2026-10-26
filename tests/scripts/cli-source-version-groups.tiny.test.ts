import history from '../fixtures/independent-admission/pre-private-service-cli-groups.original.json';
import{preServicePackOriginal}from'./pre-service-pack-api-originals';
import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {CLI_SOURCE_POLICY,CLI_SOURCE_VERSION_GROUPS,reviewedCliSourceVersion,verifyCliInputSet} from '../../scripts/lib/independent-admission/source-rules';
const files={producer:'scripts/check-cli-publication.cjs',publicationBudget:'scripts/lib/cli-publication-budget.cjs',sourceHelper:'scripts/lib/module-source-materials.py',sourceLimits:'scripts/lib/module-artifact-limits.json',copier:'scripts/cli-build-inputs.cjs',supervisor:'scripts/lib/afs-publication-command.cjs',workflow:'.github/workflows/cli-package.yml'};
const actual=Object.fromEntries(Object.entries(files).map(([key,file])=>[key,createHash('sha256').update(readFileSync(file)).digest('hex')])) as Record<keyof typeof CLI_SOURCE_POLICY,string>;
test('actual callback source helper belongs to the complete current CLI tuple',()=>{expect(reviewedCliSourceVersion(actual,name=>readFileSync(name))).toBe(true);expect(actual.sourceHelper).toBe('d0bcdbdec78a1bdb2cebb90910b4dd7c678c5027fc9856fc5475961b3da10dd1');for(const key of Object.keys(files) as (keyof typeof CLI_SOURCE_POLICY)[])expect(reviewedCliSourceVersion({...actual,[key]:'0'.repeat(64)})).toBe(false);});
test('preserves every historical reviewed combination without lending it the new helper',()=>{const old=CLI_SOURCE_VERSION_GROUPS[0]!;for(const supervisor of old.supervisors)for(const workflow of old.workflows)expect(reviewedCliSourceVersion({...CLI_SOURCE_POLICY,supervisor,workflow})).toBe(true);expect(reviewedCliSourceVersion({...actual,workflow:'c856baf24a28fe789db1e80c26e7b69b7e4e08bd0923f52ce376840ac885c1eb'})).toBe(false);expect(reviewedCliSourceVersion({...actual,supervisor:CLI_SOURCE_POLICY.supervisor})).toBe(false);});

test('refuses the unreviewed historical-supervisor plus current-payload mixture',()=>{
 // The final group declares ONLY the reviewed R226 supervisor (30b890b9) with the
 // current payload (f8817645). A historical supervisor (7fb899a7) paired with that
 // current payload was never reviewed and must be refused.
 expect(()=>reviewedCliSourceVersion({...actual,supervisor:'7fb899a72bd50ae36b35649964e502c5984a97587ffd5570f6d830fb31d6bd27'},name=>readFileSync(name)))
  .toThrow(/catalog CLI complete source binding mismatch/u);
 // the reviewed current tuple still resolves...
 expect(reviewedCliSourceVersion({...actual,supervisor:'30b890b9b73e819b40b1fc4de511b80cad50255d99af7d0699315b06e4a5a2c3'},name=>readFileSync(name))).toBe(true);
 // ...and the published old supervisor keeps its own coherent old payload tuple.
 expect(reviewedCliSourceVersion({...actual,sourceHelper:'99eb684db2712cee74ae40f7ac17a55c1dcd74682162b75947203cf2628c6e16',
  supervisor:'7fb899a72bd50ae36b35649964e502c5984a97587ffd5570f6d830fb31d6bd27'},
  name=>name==='scripts/workspace-package-payload.cjs'?Buffer.from(priorShared.files.find(row=>row.path==='scripts/workspace-package-payload.cjs')!.rawBase64,'base64'):readFileSync(name))).toBe(true);
});

test('keeps the prior callback tuple exact',()=>{expect(reviewedCliSourceVersion({...actual,producer:'ff0eb13abb628addad1c8fdfd3ee6d615215325e9ad7bc8799139a056e316c75',sourceHelper:'c28f194ca9767f2aeddd9cff6f633dac2280ae9c4e5d716d3273706afce81850',supervisor:'7fb899a72bd50ae36b35649964e502c5984a97587ffd5570f6d830fb31d6bd27'})).toBe(true);});

test('catalog CLI source tuple binds every newly executed catalog original before granting source facts',()=>{
 const current=CLI_SOURCE_VERSION_GROUPS.at(-1)!;expect(current.sourceBindings?.length).toBe(5);
 for(const binding of current.sourceBindings??[]){expect(createHash('sha256').update(readFileSync(binding.path)).digest('hex')).toBe(binding.sha256);expect(()=>verifyCliInputSet([],{},name=>name===binding.path?Buffer.from('wrong original'):readFileSync(name),[])).toThrow('catalog CLI complete source binding mismatch');}
 expect(reviewedCliSourceVersion({...actual,sourceHelper:'c28f194ca9767f2aeddd9cff6f633dac2280ae9c4e5d716d3273706afce81850'})).toBe(false);
});

test('keeps the precompression catalog helper tuple exact',()=>{expect(reviewedCliSourceVersion({...actual,sourceHelper:'1871c59b9f0bfb4c0ce824123ce9cdc5f472aba11245b5e0eb45c62c4fca42e2',supervisor:'7fb899a72bd50ae36b35649964e502c5984a97587ffd5570f6d830fb31d6bd27'})).toBe(true);});

const entityActual={...actual,sourceHelper:'99eb684db2712cee74ae40f7ac17a55c1dcd74682162b75947203cf2628c6e16',supervisor:'7fb899a72bd50ae36b35649964e502c5984a97587ffd5570f6d830fb31d6bd27'};
test('new same-primary CLI source tuple observes its own manifest bytes and preserves all seven old complete JSONs',()=>{
 // Every historically published tuple stays byte-identical at its own index; the
 // ORM 0.3.26 joint tuple is a genuine append bound to the ACTUAL manifest bytes.
 const publishedCount=history.hashes.length;
 expect(CLI_SOURCE_VERSION_GROUPS.length).toBe(publishedCount+5);
 for(let i=0;i<history.hashes.length;i++)expect(createHash('sha256').update(JSON.stringify(CLI_SOURCE_VERSION_GROUPS[i])).digest('hex')).toBe(history.hashes[i]!);
 const orm326=(CLI_SOURCE_VERSION_GROUPS as any[]).at(-1)!;
 for(const binding of orm326.sourceBindings??[])expect(createHash('sha256').update(readFileSync(binding.path)).digest('hex')).toBe(binding.sha256);
 // Strict negative: the historical manifest value must NOT select the new tuple.
 const ormKeys=orm326.secondarySourcePaths as string[];
 expect(ormKeys).toContain('package.json');expect(ormKeys).toContain('bun.lock');
 // Drift in an owned discriminator is a hard failure, never a silent false.
 expect(()=>reviewedCliSourceVersion(actual,name=>name==='package.json'?Buffer.from('{"changed":true}'):readFileSync(name))).toThrow('catalog CLI complete source binding mismatch');
 // The current manifest really does select the ORM tuple; the historical
 // 0.3.25 manifest bytes must not.
 // The HISTORICAL f803 observation still selects its own published tuple, which is
 // exactly why the new tuple must be discriminated by actual manifest bytes.
 expect(reviewedCliSourceVersion(actual,name=>readFileSync(name))).toBe(true);
 expect(reviewedCliSourceVersion(entityActual)).toBe(false);expect(reviewedCliSourceVersion(entityActual,name=>preServicePackOriginal(name)??readFileSync(name))).toBe(true);expect(reviewedCliSourceVersion(entityActual,name=>name==='scripts/workspace-package-payload.cjs'?Buffer.from(priorShared.files.find(row=>row.path==='scripts/workspace-package-payload.cjs')!.rawBase64,'base64'):readFileSync(name))).toBe(true);expect(()=>reviewedCliSourceVersion(entityActual,name=>readFileSync(name))).toThrow(/catalog CLI complete source binding mismatch/u);expect(()=>reviewedCliSourceVersion(entityActual,()=>Buffer.from('mixed manifest'))).toThrow(/catalog CLI complete source binding mismatch/u);expect(()=>reviewedCliSourceVersion(entityActual,()=>{throw Error('missing owned manifest');})).toThrow('missing owned manifest');
});

import entityHistory from '../fixtures/independent-admission/pre-sdk46-cli-whole-hashes.original.json';
import priorShared from '../fixtures/independent-admission/pre-sdk46-shared-api-originals.original.json';
test('shared payload CLI version preserves all eight actual f72 recipes and stages only already-owned discriminators',()=>{
 expect(entityHistory.base).toBe('f72f8a8ab3f304631e7d4357be552dd441ea9a0d');expect(entityHistory.hashes.length).toBe(8);
 for(let i=0;i<entityHistory.hashes.length;i++)expect(createHash('sha256').update(JSON.stringify(CLI_SOURCE_VERSION_GROUPS[i])).digest('hex')).toBe(entityHistory.hashes[i]!);
 const payload='scripts/workspace-package-payload.cjs',prior=priorShared.files.find(row=>row.path===payload)!;const raw=Buffer.from(prior.rawBase64,'base64');expect(raw.length).toBe(prior.bytes);expect(createHash('sha256').update(raw).digest('hex')).toBe(prior.sha256);
 const oldReads:string[]=[];expect(reviewedCliSourceVersion(entityActual,name=>{oldReads.push(name);if(name===payload)throw Error('old CLI must not fetch a future role');return preServicePackOriginal(name)??readFileSync(name);})).toBe(true);expect(oldReads).not.toContain(payload);
 const readCurrent:string[]=[];expect(reviewedCliSourceVersion(entityActual,name=>{readCurrent.push(name);return name===payload?raw:readFileSync(name);})).toBe(true);expect(readCurrent).toEqual(['scripts/prepare-package-manifest.cjs',payload]);
 expect(reviewedCliSourceVersion(entityActual,name=>name===payload?raw:readFileSync(name))).toBe(true);
 expect(()=>reviewedCliSourceVersion(entityActual,name=>name===payload?Buffer.from('wrong payload'):readFileSync(name))).toThrow('catalog CLI complete source binding mismatch');
 expect(()=>reviewedCliSourceVersion(entityActual,name=>{if(name===payload)throw Error('missing payload');return readFileSync(name);})).toThrow('missing payload');
});

import buildHistory from '../fixtures/independent-admission/pre-sdk47-cli-whole-hashes.original.json';
test('one-pass source helper keeps all nine prior CLI recipes and owns its complete binding set',()=>{expect(buildHistory.hashes.length).toBe(9);for(let i=0;i<9;i++)expect(createHash('sha256').update(JSON.stringify(CLI_SOURCE_VERSION_GROUPS[i])).digest('hex')).toBe(buildHistory.hashes[i]!);
// The CURRENT tree selects the ORM 0.3.26 tail; the historical f803 `actual`
// observation is the strict negative and must NOT resolve.
// Historical f803 selects its published tuple; the CURRENT tree selects the ORM tail.
expect(reviewedCliSourceVersion(actual,name=>readFileSync(name))).toBe(true);
const currentObserved={...actual,
 producer:createHash('sha256').update(readFileSync('scripts/check-cli-publication.cjs')).digest('hex'),
 publicationBudget:createHash('sha256').update(readFileSync('scripts/lib/cli-publication-budget.cjs')).digest('hex'),
 sourceHelper:createHash('sha256').update(readFileSync('scripts/lib/module-source-materials.py')).digest('hex'),
 sourceLimits:createHash('sha256').update(readFileSync('scripts/lib/module-artifact-limits.json')).digest('hex'),
 copier:createHash('sha256').update(readFileSync('scripts/cli-build-inputs.cjs')).digest('hex'),
 supervisor:createHash('sha256').update(readFileSync('scripts/lib/afs-publication-command.cjs')).digest('hex'),
 workflow:createHash('sha256').update(readFileSync('.github/workflows/cli-package.yml')).digest('hex')};
const currentReads:string[]=[];expect(reviewedCliSourceVersion(currentObserved,name=>{currentReads.push(name);return readFileSync(name);})).toBe(true);
expect(currentReads).toEqual(CLI_SOURCE_VERSION_GROUPS.at(-1)!.secondarySourcePaths);const last=CLI_SOURCE_VERSION_GROUPS.at(-1)!,priorOnePass=CLI_SOURCE_VERSION_GROUPS[8]!;
expect(last.sourceBindings!.length).toBe(priorOnePass.sourceBindings!.length);
// Only the reviewed ORM facts may differ from the prior complete tuple.
const REVIEWED_ORM_ROLES=new Set(['scripts/workspace-package-payload.cjs','package.json','bun.lock']);
for(const row of last.sourceBindings!){const prior=priorOnePass.sourceBindings!.find(item=>item.path===row.path)!;expect(prior).toBeDefined();if(!REVIEWED_ORM_ROLES.has(row.path))expect(row.sha256).toBe(prior.sha256);else expect(row.sha256).toBe(createHash('sha256').update(readFileSync(row.path)).digest('hex'));}expect(last.sourceBindings!.find(row=>row.path==='scripts/workspace-package-payload.cjs')!.sha256).toBe(createHash('sha256').update(readFileSync('scripts/workspace-package-payload.cjs')).digest('hex'));});
