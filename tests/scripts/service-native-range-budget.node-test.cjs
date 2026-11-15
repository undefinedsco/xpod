'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
test('real private native collector range ceiling (isolated upstream simulation)',()=>{
 const result=spawnSync('bun',['test','./tests/scripts/service-native-range-budget.fixture.ts'],{cwd:path.resolve(__dirname,'../..'),encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
 assert.equal(result.error,undefined,String(result.error));assert.equal(result.status,0,result.stdout+result.stderr);
});
