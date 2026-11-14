'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createPackPhase}=require('../../scripts/service-pack-phase.cjs');
const M=1024*1024;
function phase(){let clock=10;return {p:createPackPhase({deadlineUnixMs:100,retainedCeilingBytes:128*M,now:()=>clock}),expire(){clock=100;}};}
test('reservation occupies existing allocation before writes and settles actual bytes exactly once',()=>{
 const {p}=phase(),start=p.remainingBytes(),token=p.reserveOriginalMaximum(2*M);assert.equal(p.remainingBytes(),start-2*M);assert.equal(p.snapshot().reservedOriginalBytes,2*M);assert.throws(()=>p.reserveBytes(start-2*M+1),/exhausted/);
 p.settleOriginalReservation(token,M,true);assert.equal(p.remainingBytes(),start-M);assert.equal(p.snapshot().actualChargedBytes,M);assert.equal(p.snapshot().reservedOriginalBytes,0);assert.throws(()=>p.settleOriginalReservation(token,0,true),/unique/);
});
test('forged/cross-parent/oversize/unproven-refund do not release a reservation',()=>{
 const {p}=phase(),other=phase().p,token=p.reserveOriginalMaximum(M),left=p.remainingBytes();
 for(const action of[()=>p.settleOriginalReservation({},0,true),()=>other.settleOriginalReservation(token,0,true),()=>p.settleOriginalReservation(token,M+1,true),()=>p.settleOriginalReservation(token,M-1,false),()=>p.reserveOriginalMaximum(0)])assert.throws(action);
 assert.equal(p.remainingBytes(),left);assert.equal(p.snapshot().reservedOriginalBytes,M);p.settleOriginalReservation(token,M,false);assert.equal(p.remainingBytes(),left);assert.equal(p.snapshot().actualChargedBytes,M);
});
test('expired parent refuses reserve and settle without extending deadline or releasing physical claims',()=>{
 const {p,expire}=phase(),token=p.reserveOriginalMaximum(M);expire();assert.throws(()=>p.reserveOriginalMaximum(1),/deadline/);assert.throws(()=>p.settleOriginalReservation(token,0,true),/deadline/);
});
