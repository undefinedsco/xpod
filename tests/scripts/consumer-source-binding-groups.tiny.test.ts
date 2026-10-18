import {test,expect} from 'bun:test';
import {CONSUMER_SOURCE_GROUPS,CONTROLLER_POLICY_BINDINGS} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {sourceBindingKey,selectGitHubSourceBindingGroup} from '../../scripts/lib/independent-admission/github-source-binding-groups';
test('complete old/new workflow tuples select only their whole source recipe',()=>{
 for(const group of CONSUMER_SOURCE_GROUPS){const observed=new Map([...group.selectors,...(group.secondarySelectors??[])].map(row=>[sourceBindingKey(row),row.sha256]));expect(selectGitHubSourceBindingGroup(CONSUMER_SOURCE_GROUPS,observed)).toBe(group);}
 const mixed=new Map(CONSUMER_SOURCE_GROUPS[0]!.selectors.map(row=>[sourceBindingKey(row),row.sha256]));
 const next=CONSUMER_SOURCE_GROUPS[1]!.selectors.find(row=>row.path.includes('archive-consumer'))!;mixed.set(sourceBindingKey(next),next.sha256);
 expect(()=>selectGitHubSourceBindingGroup(CONSUMER_SOURCE_GROUPS,mixed)).toThrow('group not reviewed');
});
test('new group pins actual dynamic execution helpers without self hash recursion',()=>{
 const rows=CONSUMER_SOURCE_GROUPS[1]!.sourceBindings;const paths=new Set(rows.map(row=>row.path));expect(paths.size).toBe(rows.length);
 for(const required of ['scripts/lib/independent-admission/afs-consumer-registry-originals.ts','scripts/lib/independent-admission/afs-verifier-patch-originals.ts','scripts/lib/registry-legal-original-limits.json','scripts/bun-test-discovery.cjs','scripts/test-runner-ownership.cjs','scripts/lib/consumer-workflow-budget.cjs','scripts/run-independent-publication.ts','scripts/lib/afs-module-consumer.py','scripts/lib/afs-verifier-harness.py','scripts/lib/afs-consumer-tool-originals.py','scripts/agentfs-native-ci/mounted/required-cases.ts','scripts/lib/afs-consumer-budget.cjs','scripts/lib/afs-consumer-budget.json','scripts/lib/independent-admission/afs-verifier-runtime-originals.ts','scripts/lib/independent-admission/legal-bun-runtime.ts','scripts/lib/independent-admission/github-origin.ts','scripts/lib/inspect-product-artifact.py','qlever/scripts/sdk-debian-index-observer.py','qlever/scripts/sdk-debian-index-bindings.py','qlever/scripts/sdk-symlink-originals.py','scripts/lib/independent-admission/qlever-sdk-debian-index.ts','scripts/lib/independent-admission/qlever-sdk-symlinks.ts','scripts/lib/independent-admission/native-archive-observation-budget.ts','bun.lock'])expect(paths.has(required)).toBe(true);
 expect(CONTROLLER_POLICY_BINDINGS.length).toBe(2);
 for(const anchor of CONTROLLER_POLICY_BINDINGS)expect(rows.find(row=>row.path===anchor.path)).toBe(anchor);
 expect(CONSUMER_SOURCE_GROUPS[0]!.sourceBindings.some(row=>CONTROLLER_POLICY_BINDINGS.some(anchor=>anchor.path===row.path))).toBe(false);
 expect(rows.every(row=>/^[a-f0-9]{64}$/u.test(row.sha256)&&!row.reviewedSha256)).toBe(true);
});

test('catalog and retained historical implementation select complete existing-path source tuples',()=>{
 const next=CONSUMER_SOURCE_GROUPS[1]!,old=CONSUMER_SOURCE_GROUPS[2]!;expect(old.sourceBindings).toHaveLength(335);expect(next.secondarySelectors?.map(row=>row.path)).toEqual(old.secondarySelectors?.map(row=>row.path));
 const tuple=(group:typeof next)=>new Map([...group.selectors,...(group.secondarySelectors??[])].map(row=>[sourceBindingKey(row),row.sha256]));
 expect(selectGitHubSourceBindingGroup(CONSUMER_SOURCE_GROUPS,tuple(old))).toBe(old);
 for(const row of next.secondarySelectors??[]){const mixed=tuple(next);mixed.set(sourceBindingKey(row),'f'.repeat(64));expect(()=>selectGitHubSourceBindingGroup(CONSUMER_SOURCE_GROUPS,mixed)).toThrow();}
 for(const path of ['package.json','bun.lock','scripts/lib/physical-module-stage.ts','scripts/prepare-package-manifest.cjs'])expect(old.sourceBindings.find(row=>row.path===path)?.sha256).not.toBe(next.sourceBindings.find(row=>row.path===path)?.sha256);
});

test('hoisted build-tools use a distinct whole closure and old versions never require the new module',()=>{
 const next=CONSUMER_SOURCE_GROUPS[1]!;
 const old=CONSUMER_SOURCE_GROUPS.find(group=>group!==next&&group.sourceBindings.some(row=>row.path==='qlever/scripts/sdk-fetchcontent-materials.py')&&!group.sourceBindings.some(row=>row.path==='packages/xpod-cli/src/build-dependency-layout.ts'))!;
 expect(old).toBeDefined();
 const path='packages/xpod-cli/scripts/build-tools-package.ts';
 expect(next.secondarySelectors?.find(row=>row.path===path)?.sha256).not.toBe(old.secondarySelectors?.find(row=>row.path===path)?.sha256);
 expect(next.sourceBindings.some(row=>row.path==='packages/xpod-cli/src/build-dependency-layout.ts')).toBe(true);
 expect(old.sourceBindings.some(row=>row.path==='packages/xpod-cli/src/build-dependency-layout.ts')).toBe(false);
 for(const group of [old,next]){const observed=new Map([...group.selectors,...(group.secondarySelectors??[])].map(row=>[sourceBindingKey(row),row.sha256]));expect(selectGitHubSourceBindingGroup(CONSUMER_SOURCE_GROUPS,observed)).toBe(group);observed.set('source:'+path,'e'.repeat(64));expect(()=>selectGitHubSourceBindingGroup(CONSUMER_SOURCE_GROUPS,observed)).toThrow();}
});
