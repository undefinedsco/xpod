'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
test('fixed service workspace replay executes and rejects incomplete output under shared bounds',()=>{
 const result=spawnSync('python3',['-m','unittest','qlever/tests/test_service_workspace_replay.py'],{cwd:path.resolve(__dirname,'../..'),encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
 assert.equal(result.error,undefined,String(result.error));
 assert.equal(result.status,0,result.stdout+result.stderr);
});
