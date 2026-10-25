'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeManifest } = require('../../scripts/prepare-package-manifest.cjs');
test('explicit same-call platform policy controls the existing pure seed projection', () => {
  const input = {name:'fixture',version:'1.0.0',scripts:{prepack:'hook',build:'build'},optionalDependencies:{'@undefineds.co/xpod-linux-x64':'1.0.0',other:'2.0.0'}};
  const original = JSON.stringify(input);
  const without = sanitizeManifest(input,{includePlatformPackages:false});
  const withPackages = sanitizeManifest(input,{includePlatformPackages:true});
  assert.deepEqual(without.optionalDependencies,{other:'2.0.0'});
  assert.deepEqual(withPackages.optionalDependencies,input.optionalDependencies);
  assert.deepEqual(without.scripts,{build:'build'});
  assert.equal(JSON.stringify(input),original);
  for (const policy of [null,{}, {includePlatformPackages:1},{includePlatformPackages:false,other:true}]) assert.throws(()=>sanitizeManifest(input,policy));
});
