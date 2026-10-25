'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
test('same private runtime artifact repeated reads and custody revocation',()=>{
 for(const replacement of ['', '1', 'installed']){const result=spawnSync('bun',['test','--timeout','60000','./tests/scripts/service-runtime-private-reader.fixture.ts'],{cwd:path.resolve(__dirname,'../..'),env:{...process.env,SERVICE_RUNTIME_REPLACE_ARCHIVE:replacement==='1'?'1':'',SERVICE_RUNTIME_INSTALLED:replacement==='installed'?'1':'',SERVICE_PRIVATE_LARGE:'1',SERVICE_PRIVATE_PACK:'1',SERVICE_FINAL_PACK_READER:'1',SERVICE_PACK_PAYLOAD_BYTES:'2097152',SERVICE_PACK_NEGATIVE:'',SERVICE_PACK_BAD_SUPERVISION:''},encoding:'utf8',timeout:70000,maxBuffer:1024*1024});
 assert.equal(result.error,undefined,String(result.error));assert.equal(result.status,0,result.stdout+result.stderr);}
});
