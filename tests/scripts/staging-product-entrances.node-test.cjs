const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const crypto=require('node:crypto');
const read=p=>fs.readFileSync(p,'utf8');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
test('normal product entrances build staging exact SHA without publishing',()=>{
 const origin=read('scripts/lib/independent-admission/github-origin.ts');
 const source=read('scripts/lib/independent-admission/source-rules.ts');
 for(const name of ['api-module-product','cli-package']){
  const workflow=read(`.github/workflows/${name}.yml`);
  assert.match(workflow,/on:\n  push:\n    branches: \[staging\]\n/);
  assert.match(workflow,/workflow_dispatch:/);
  assert.match(workflow,/ref: \$\{\{ github.sha \}\}/);
  assert.doesNotMatch(workflow,/NPM_TOKEN|npm publish|run-independent-publication/);
  assert.ok((name==='cli-package'?source:origin).includes(hash(workflow)));
 }
 assert.match(origin,/run.head_branch!=='staging'/);
 assert.match(origin,/input.sourceSha!==input.runHeadSha/);
 // Both the historical single workflow and the reviewed API version array
 // must use exact full-hash membership; branch/source equality stays mandatory.
 assert.match(origin,/!\(policy\.stagingPushWorkflowSha256s\?\?\[policy\.stagingPushWorkflowSha256!\]\)\.includes\(workflowSha256\)/);
 assert.match(origin,/policy\.stagingPushWorkflowSha256\|\|policy\.stagingPushWorkflowSha256s/);
 assert.ok(origin.includes('c856baf24a28fe789db1e80c26e7b69b7e4e08bd0923f52ce376840ac885c1eb'));
 assert.ok(origin.includes('e9326b1254fbcf933cbbe09c41f5dcf492bfa70ff265d2ea1cd0589c11d4da98'));
});
