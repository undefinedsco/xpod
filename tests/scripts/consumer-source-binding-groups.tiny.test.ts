import {test,expect} from 'bun:test';
import {CONSUMER_SOURCE_GROUPS,CONTROLLER_POLICY_BINDINGS} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {sourceBindingKey,selectGitHubSourceBindingGroup} from '../../scripts/lib/independent-admission/github-source-binding-groups';
test('complete old/new workflow tuples select only their whole source recipe',()=>{
 for(const group of CONSUMER_SOURCE_GROUPS){const observed=new Map(group.selectors.map(row=>[sourceBindingKey(row),row.sha256]));expect(selectGitHubSourceBindingGroup(CONSUMER_SOURCE_GROUPS,observed)).toBe(group);}
 const mixed=new Map(CONSUMER_SOURCE_GROUPS[0]!.selectors.map(row=>[sourceBindingKey(row),row.sha256]));
 const next=CONSUMER_SOURCE_GROUPS[1]!.selectors.find(row=>row.path.includes('archive-consumer'))!;mixed.set(sourceBindingKey(next),next.sha256);
 expect(()=>selectGitHubSourceBindingGroup(CONSUMER_SOURCE_GROUPS,mixed)).toThrow('group not reviewed');
});
test('new group pins actual dynamic execution helpers without self hash recursion',()=>{
 const rows=CONSUMER_SOURCE_GROUPS[1]!.sourceBindings;const paths=new Set(rows.map(row=>row.path));expect(paths.size).toBe(rows.length);
 for(const required of ['scripts/lib/independent-admission/afs-consumer-registry-originals.ts','scripts/lib/independent-admission/afs-verifier-patch-originals.ts','scripts/lib/registry-legal-original-limits.json','scripts/bun-test-discovery.cjs','scripts/test-runner-ownership.cjs','scripts/lib/consumer-workflow-budget.cjs','scripts/run-independent-publication.ts','scripts/lib/afs-module-consumer.py','scripts/lib/afs-verifier-harness.py','scripts/lib/afs-consumer-tool-originals.py','scripts/agentfs-native-ci/mounted/required-cases.ts','scripts/lib/afs-consumer-budget.cjs','scripts/lib/afs-consumer-budget.json','scripts/lib/independent-admission/afs-verifier-runtime-originals.ts','scripts/lib/independent-admission/legal-bun-runtime.ts','scripts/lib/independent-admission/github-origin.ts','scripts/lib/inspect-product-artifact.py','bun.lock'])expect(paths.has(required)).toBe(true);
 expect(CONTROLLER_POLICY_BINDINGS.length).toBe(2);
 for(const anchor of CONTROLLER_POLICY_BINDINGS)expect(rows.find(row=>row.path===anchor.path)).toBe(anchor);
 expect(CONSUMER_SOURCE_GROUPS[0]!.sourceBindings.some(row=>CONTROLLER_POLICY_BINDINGS.some(anchor=>anchor.path===row.path))).toBe(false);
 expect(rows.every(row=>/^[a-f0-9]{64}$/u.test(row.sha256)&&!row.reviewedSha256)).toBe(true);
});
