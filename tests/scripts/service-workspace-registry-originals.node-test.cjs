'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
test('retained registry producer preserves closed transport, SRI and caller ledger',()=>{
 const result=spawnSync('python3',['-m','unittest','discover','-s','qlever/tests','-p','test_service_workspace_registry_originals.py'],{cwd:path.resolve(__dirname,'../..'),encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
 assert.equal(result.error,undefined,String(result.error));assert.equal(result.status,0,result.stdout+result.stderr);
});
