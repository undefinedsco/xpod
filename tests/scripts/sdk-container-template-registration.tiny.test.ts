import {test,expect} from 'bun:test';import {createHash} from 'node:crypto';import fs from 'node:fs';import path from 'node:path';
import previous from '../fixtures/independent-admission/sdk26-pre-template-source-groups.original.json';
import {QLEVER_SDK_EXECUTION_GROUPS as sdk} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
test('SDK26 preserves every old whole source recipe and promotes only its own mandatory originals',()=>{
 for(const[name,groups]of Object.entries({sdk,consumer,ci})){
  const old=previous[name as keyof typeof previous];expect(groups).toHaveLength(old.length+(name==='sdk'?22:name==='ci'?48:24));
  for(let i=0;i<old.length;i++){const g=groups[i]!,before=old[i]!;expect(g.selectors).toEqual(before.selectors);expect(hash(g.sourceBindings)).toBe(before.sourceBindingsSha256);const metadata=Object.fromEntries(Object.entries(g).filter(([k])=>!['selectors','secondarySelectors','sourceBindings'].includes(k)));expect(hash(metadata)).toBe(before.metadataSha256);
   for(const role of before.secondarySelectors)expect(g.secondarySelectors?.some(row=>JSON.stringify(row)===JSON.stringify(role))).toBe(true);
   for(const role of g.secondarySelectors??[])if(!before.secondarySelectors.some(old=>JSON.stringify(old)===JSON.stringify(role)))expect([...g.selectors,...g.sourceBindings].some(row=>JSON.stringify(row)===JSON.stringify(role))).toBe(true);
  }
 }
 expect(current).toHaveLength(420);for(const row of current)expect(createHash('sha256').update(fs.readFileSync(path.resolve(import.meta.dir,'../..',row.path))).digest('hex')).toBe(row.sha256);
 const latest=sdk[sdk.length-1]!;for(const row of [...latest.selectors,...latest.sourceBindings])expect(createHash('sha256').update(fs.readFileSync(path.resolve(import.meta.dir,'../..',row.path))).digest('hex')).toBe(row.sha256);
});
