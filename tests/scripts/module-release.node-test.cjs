const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { parseTag, inventory, verifyReview, prepare } = require('../../scripts/module-release.cjs');
test('module tags are independent from service tags and select stable versus preview channels', () => {
  assert.deepEqual(parseTag('cli-v1.2.3'), { id: 'cli', version: '1.2.3', channel: 'latest' });
  assert.equal(parseTag('afs-v1.2.3-rc.1').channel, 'next');
  for (const tag of ['v1.2.3', 'fabric-v1.2.3', 'cli-v../bad', 'api-v1.2']) assert.throws(() => parseTag(tag));
  assert.throws(() => prepare('afs-v1.2.3'), /module_artifact_not_ready/);
});
test('release review binds the full artifact and all three existing distribution obligations', () => {
  fs.mkdirSync('.test-data', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('.test-data/module-release-review-'));
  try {
    fs.mkdirSync(path.join(root,'dist')); for (const name of ['package.json','LICENSE','README.md','dist/entry.mjs']) fs.writeFileSync(path.join(root,name),name);
    const contentSha256 = inventory(root); const expected = { id: 'cli', version:'1.2.3', contentSha256 };
    const review = { schemaVersion:1, status:'verified', module:'cli', version:'1.2.3', contentSha256, evidence: ['licenses','source','gateway'].map(kind => { const name=kind+'.json'; fs.writeFileSync(path.join(root,name),kind); return {kind,path:name,status:'verified',sha256:crypto.createHash('sha256').update(kind).digest('hex')}; }) };
    verifyReview(review,expected,root);
    assert.throws(()=>verifyReview({...review,status:'partial-collection'},expected,root));
    assert.throws(()=>verifyReview({...review,evidence:review.evidence.slice(0,2)},expected,root));
    assert.throws(()=>verifyReview({...review,evidence:review.evidence.map(e=>({...e,path:'../escape'}))},expected,root));
    fs.writeFileSync(path.join(root,'gateway.json'),'changed'); assert.throws(()=>verifyReview(review,expected,root));
    fs.writeFileSync(path.join(root,'dist/entry.mjs'),'changed'); assert.notEqual(inventory(root),contentSha256);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('release consumes the verified artifact without root installation, service build, RC or deployment', () => {
  const workflow=fs.readFileSync('.github/workflows/module-release.yml','utf8');
  assert.ok(workflow.includes("tags: ['cli-v*', 'afs-v*', 'api-v*', 'css-v*']"));
  assert.ok(workflow.includes('needs: candidate')); assert.ok(workflow.includes('node scripts/module-release.cjs'));
  for(const forbidden of ['bun install','docker build','kubectl','release-candidate.cjs'])assert.ok(!workflow.includes(forbidden));
  assert.ok(workflow.includes('--ignore-scripts')); assert.ok(workflow.includes('artifactSha256!==h'));
});
