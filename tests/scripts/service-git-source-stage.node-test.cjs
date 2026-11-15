'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
test('existing private Git source stages exact blobs and links, rejects copied caps and bounds real slow child',()=>{
 const result=spawnSync('bun',['test','--timeout','60000','./tests/scripts/service-runtime-private-reader.fixture.ts'],{cwd:path.resolve(__dirname,'../..'),env:{...process.env,SERVICE_SOURCE_BULK_PROBE:'1',SERVICE_RUNTIME_INSTALLED:'',SERVICE_REAL_BUN_PROBE:'',SERVICE_RETAINED_REAL_DIR:'',SERVICE_PACK_OFFICIAL_ARCHIVE:''},encoding:'utf8',timeout:70000,maxBuffer:1024*1024});
 assert.equal(result.error,undefined,String(result.error));assert.equal(result.status,0,result.stdout+result.stderr);
 assert.match(result.stdout+result.stderr,/"slowChildEntered":true/);
});
