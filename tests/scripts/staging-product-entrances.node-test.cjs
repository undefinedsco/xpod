const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const read=p=>fs.readFileSync(p,'utf8');
test('normal product entrances build staging exact SHA without publishing',()=>{
 const origin=read('scripts/lib/independent-admission/github-origin.ts');
 for(const name of ['api-module-product','cli-package']){
  const workflow=read(`.github/workflows/${name}.yml`);
  assert.match(workflow,/on:\n  push:\n    branches: \[staging\]\n/);
  assert.match(workflow,/workflow_dispatch:/);
  assert.match(workflow,/ref: \$\{\{ github.sha \}\}/);
  assert.doesNotMatch(workflow,/NPM_TOKEN|npm publish|run-independent-publication/);
 }
 assert.match(origin,/run.head_branch!=='staging'/);
 assert.match(origin,/input.sourceSha!==input.runHeadSha/);
 // A staging push must come from staging with the exact source; workflow bytes are no
 // longer compared with a registered hash (docs/retire-source-registration.md).
 assert.match(origin,/policy\.stagingPushWorkflowSha256\|\|policy\.stagingPushWorkflowSha256s/);
});
