'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {createPackPhase}=require('../../scripts/service-pack-phase.cjs');const M=4*1024*1024;
function fixture(now=Date.now){return createPackPhase({deadlineUnixMs:now()+10000,retainedCeilingBytes:4*M,now});}
test('one parent end and allocation remain authoritative without a child window',()=>{
 let time=100;const phase=fixture(()=>time);assert.equal(phase.remainingBytes(),2*M);phase.reserveBytes(17);assert.equal(phase.remainingBytes(),2*M-17);phase.metadataStart();assert.equal(phase.remainingBytes(),3*M-17);time=10100;assert.throws(()=>phase.check(),/absolute deadline exhausted/);assert.throws(()=>phase.reserveBytes(0),/absolute deadline/);
});
test('actual child exit, both raw streams and exact argv are recorded before a failure propagates',()=>{
 const phase=fixture(),buffers=[],events=[];phase.attachRecorder({retainBuffer(bytes,role){phase.reserveBytes(bytes.length);buffers.push({role,bytes:Buffer.from(bytes)});return {path:role,bytes:bytes.length};},event(row){events.push(row);}});
 const result=phase.execFileSync(process.execPath,['-e','process.stdout.write("actual");process.stderr.write("error")'],{encoding:'utf8'});assert.equal(result,'actual');assert.deepEqual(buffers.map(row=>row.bytes.toString()),['actual','error']);assert.equal(events[0].actualWait,true);assert.equal(events[0].exit,0);assert.equal(events[0].command,process.execPath);
 assert.throws(()=>phase.execFileSync(process.execPath,['-e','process.exit(7)']),/did not exit zero/);assert.equal(events[1].exit,7);assert.equal(events[1].actualWait,true);
});
test('expired parent never spawns and a missing recorder cannot grant an observed command',()=>{
 let time=0;const phase=fixture(()=>time);time=10000;assert.throws(()=>phase.execFileSync('/not-a-command',[]),/absolute deadline/);const other=fixture();assert.throws(()=>other.execFileSync(process.execPath,['-e','']),/recorder required/);
});
