import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import before from '../fixtures/independent-admission/sdk33-pre-source-groups.original.json';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as api} from '../../scripts/lib/independent-admission/github-origin';
import {QLEVER_SDK_EXECUTION_GROUPS as sdk} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {sourceBindingKey as key,secondaryGitHubSourceBindingSelectors as secondary,selectGitHubSourceBindingGroup as select} from '../../scripts/lib/independent-admission/github-source-binding-groups';
const root=fileURLToPath(new URL('../../',import.meta.url)),read=(p:string)=>readFileSync(join(root,p)),sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
test('SDK33 preserves every SDK32/API18 complete original tree and binds its actual diagnostic helpers',()=>{
 const groups={api,sdk,consumer,ci};expect([api.length,sdk.length,consumer.length,ci.length]).toEqual([29,77,93,184]);
 for(const name of Object.keys(groups) as (keyof typeof groups)[])for(let i=0;i<before.groups[name].length;i++)expect(sha(JSON.stringify(groups[name][i]))).toBe(before.groups[name][i]!);
 expect(current.length).toBe(499);for(const row of [...current,...sdk[sdk.length-1]!.sourceBindings])expect(sha(read(row.path))).toBe(row.sha256);
 const workflow=read('.github/workflows/qlever-readonly-normal-job.yml').toString(),pins=JSON.parse(workflow.match(/^          pins=(.*)$/mu)![1]!) as Record<string,string>;expect(Object.keys(pins).length).toBe(21);for(const [p,h] of Object.entries(pins))expect(sha(read(p))).toBe(h);
 const policyPath='scripts/lib/independent-admission/consumer-observer-policy.ts';expect(read(policyPath).length<1000000).toBe(true);const content=read(policyPath).toString('base64').match(/.{1,60}/gu)!.join('\n')+'\n';expect(Buffer.byteLength(JSON.stringify({type:'file',path:policyPath,encoding:'base64',content}))<=2*1024**2).toBe(true);
});
// Keep the complete historical matrix; each recipe has its own bounded test.
for(const [name,groups] of Object.entries({api,sdk,consumer,ci}))for(const [index,group] of groups.entries())
test(`actual secondary original resolver rejects missing roles and never asks an old implementation for future helpers (${name}/${index})`,()=>{
const values=new Map(group.selectors.map(row=>[key(row),row.sha256]));const required=secondary(groups,values);for(const role of required){const own=[...group.selectors,...group.sourceBindings,...group.secondarySelectors??[]].find(row=>key(row)===key(role));expect(own!==undefined).toBe(true);values.set(key(role),own!.sha256);}expect(select(groups,values)).toBe(group);for(const role of required){const missing=new Map(values);missing.delete(key(role));expect(()=>select(groups,missing)).toThrow();}
});
