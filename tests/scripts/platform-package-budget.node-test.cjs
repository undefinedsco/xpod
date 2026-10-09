const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifyPlatformPackageBudget, MAX_PLATFORM_TARBALL_BYTES } = require('../../scripts/lib/platform-package-budget.cjs');
const target = {packageName:'@undefineds.co/xpod-darwin-arm64',binaryName:'xpod'};
const pack = (size) => ({name:target.packageName,version:'0.4.24',size,unpackedSize:331200000,files:['xpod','qlever/bin/xpod_qlever_local_runtime','SOURCE/SOURCE-MANIFEST.json','LICENSE'].map(path=>({path,size:100}))});
test('budget includes base64 and metadata for the actual packed tarball',()=>{
 const result=verifyPlatformPackageBudget(pack(MAX_PLATFORM_TARBALL_BYTES-65536),target,'0.4.24');
 assert.equal(result.base64AttachmentBytes,4*Math.ceil((MAX_PLATFORM_TARBALL_BYTES-65536)/3));
 assert.equal(result.publishBodyUpperBoundBytes,result.base64AttachmentBytes+65536);
 assert.equal(result.budgetOrigin,'project');
 assert.ok(result.publishBodyUpperBoundBytes<=result.maxPublishBodyBytes);
 assert.throws(()=>verifyPlatformPackageBudget(pack(MAX_PLATFORM_TARBALL_BYTES),target,'0.4.24'),/exceeds/); // metadata reserve still applies at the tar limit
});
test('rejects the v0.4.23 failed package and missing native/source runtime material',()=>{
 assert.throws(()=>verifyPlatformPackageBudget(pack(213600000),target,'0.4.24'),/exceeds/);
 for (const name of pack(100).files.map(file=>file.path)) {
  const input=pack(100);input.files=input.files.filter(file=>file.path!==name);
  assert.throws(()=>verifyPlatformPackageBudget(input,target,'0.4.24'),/missing/);
 }
 assert.throws(()=>verifyPlatformPackageBudget(pack(100),target,'0.4.23'),/identity/);
});
