import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS} from '../../scripts/lib/independent-admission/github-origin';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
const read=(name:string)=>readFileSync(path.resolve(import.meta.dir,'../..',name),'utf8');
test('normal four-host workflow selects the new exact recipe and keeps the controlled native route',()=>{
 const workflow=read('.github/workflows/api-module-product.yml'),sha=createHash('sha256').update(workflow).digest('hex');
 expect(sha).toBe('db6ca21afa33d572f24a92e96c88f425d1bf46a86d966a55be4c10de4d812263');
 expect(workflow.match(/producer_args\+=\(--workspace-recipe api-ui-root-minimal-v2\)/gu)).toHaveLength(1);
 expect(workflow).toContain('producer_args+=(--native-source-kind xpod-controlled-inngest-build-v1)');expect(workflow).toContain('matrix: ${{ fromJSON(needs.contract.outputs.matrix) }}');
 const origin=read('scripts/lib/independent-admission/github-origin.ts');expect(origin).toContain("workflowSha256:'"+sha+"',jobName:()=>`products (${target})`,sourceBindingGroups:[API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS[API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS.length-1]!]");
 expect(API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS[API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS.length-1]!.selectors[0]!.sha256).toBe(createHash('sha256').update(read('scripts/api-module-producer.py')).digest('hex'));
 expect(current.find(row=>row.path==='.github/workflows/api-module-product.yml')?.sha256).toBe(sha);
});
