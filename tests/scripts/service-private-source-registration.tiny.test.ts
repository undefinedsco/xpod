import {test,expect} from 'bun:test';import fs from 'node:fs';import {createHash} from 'node:crypto';
import {QLEVER_SDK_EXECUTION_GROUPS as sdk,QLEVER_SDK_CONSUMER_GROUPS as consumerSdk} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as api} from '../../scripts/lib/independent-admission/github-origin';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {sourceBindingKey as key,secondaryGitHubSourceBindingSelectors as secondary,selectGitHubSourceBindingGroup as select} from '../../scripts/lib/independent-admission/github-source-binding-groups';
import {CURRENT_CANONICAL_SOURCE_ROWS} from './source-binding-group.fixture';
const hash=(raw:Buffer)=>createHash('sha256').update(raw).digest('hex');
test('private service complete source includes every actual declared pack executable and six new runtime originals',()=>{
 const body=fs.readFileSync('scripts/lib/independent-admission/candidate-service-pack-output.ts','utf8');const declaration=body.slice(body.indexOf('const EXECUTED='),body.indexOf(' as const;',body.indexOf('const EXECUTED=')));const paths=[...declaration.matchAll(/'([^']+)'/gu)].map(row=>row[1]!);expect(paths.length).toBe(25);
 // The EXECUTED list is the CURRENT working tree, so it must be checked against
 // the CURRENT consumer honouring those bytes. `QLEVER_SDK_EXECUTION_GROUPS`
 // ends at SDK93, the frozen published producer, which legitimately still pins
 // the pre-fix pack bytes. Comparing the live tree to that frozen tuple tests the
 // wrong contract: the producer history is asserted separately below.
 const group=consumerSdk.at(-1)!;for(const path of paths){const row=group.sourceBindings.find(row=>row.path===path);expect(row).toBeDefined();expect(row!.sha256).toBe(hash(fs.readFileSync(path)));}
 // Historical producer coverage is retained, not replaced: the frozen producer
 // still owns the same roles, at its own published bytes.
 const frozen=sdk.at(-1)!;for(const path of paths){expect(frozen.sourceBindings.find(row=>row.path===path)).toBeDefined();}
 expect(frozen.sourceBindings.find(row=>row.path==='scripts/service-pack-originals.cjs')!.sha256)
  .not.toBe(hash(fs.readFileSync('scripts/service-pack-originals.cjs')));
 for(const path of ['qlever/scripts/sdk-service-pack-bindings.py','scripts/lib/independent-admission/candidate-service-image-output.ts','scripts/lib/independent-admission/candidate-service-output-stage.ts','scripts/lib/independent-admission/candidate-service-pack-output.ts','scripts/lib/independent-admission/candidate-service-root-mutation.ts','scripts/lib/independent-admission/service-pack-manifest-replay.ts']){const row=current.find(row=>row.path===path);expect(row?.sha256).toBe(hash(fs.readFileSync(path)));}
 expect(current.length).toBe(CURRENT_CANONICAL_SOURCE_ROWS);
});
test('new API discriminator is an original already owned by every same-primary historical candidate',()=>{
 const group=api.at(-1)!,primary=new Map(group.selectors.map(row=>[key(row),row.sha256])),roles=secondary(api,primary);expect(roles.some(row=>row.path==='scripts/workspace-package-payload.cjs')).toBe(true);const observed=new Map(primary);
 for(const role of roles){const own=[...group.selectors,...group.secondarySelectors??[],...group.sourceBindings].filter(row=>key(row)===key(role));expect(own.length>0).toBe(true);expect(new Set(own.map(row=>row.sha256)).size).toBe(1);observed.set(key(role),own[0]!.sha256);}expect(select(api,observed)).toBe(group);for(const role of roles){const missing=new Map(observed);missing.delete(key(role));expect(()=>select(api,missing)).toThrow();}
});
