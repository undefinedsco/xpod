"use strict";
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');

test('SDK ownership cohort and bounded FD fixtures retain refusal guards', {
  skip: process.platform === 'win32' ? 'Linux SDK observer requires the fcntl module' : false,
}, () => {
  const result = spawnSync('python3', ['-B', '-m', 'unittest',
    'qlever.tests.test_sdk_ownership_cohort',
    'qlever.tests.test_sdk_shared_task_ownership',
    'qlever.tests.test_sdk_write_delta_chain'], {
    cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
