/** Pure clock mechanics. The caller must supply the actual private GitHub job
 * window and separately verify process wait, raw originals and source custody. */
export interface ServiceAbiClock {
 readonly startedUTCNs:bigint;
 readonly completedUTCNs:bigint;
 readonly startedMonotonicNs:bigint;
 readonly completedMonotonicNs:bigint;
 readonly outerParentDeadlineMonotonicNs:bigint;
 readonly operationDeadlineMonotonicNs:bigint;
}
function need(value:unknown,why:string):asserts value {if(!value)throw Error('Service ABI clock: '+why);}
function decimal(value:unknown):bigint {
 need(typeof value==='string'&&/^[1-9][0-9]{0,24}$/u.test(value),'positive bounded decimal-string clock required');
 return BigInt(value);
}
export function inspectServiceAbiClock(input:{receipt:any;jobStartedUTCNs:bigint;jobCompletedUTCNs:bigint;previous?:ServiceAbiClock}):ServiceAbiClock {
 const {receipt:r,previous:p}=input;
 need(r?.timingModel==='actual-service-abi-parent-window-v1'&&r.rawClosedBeforeTiming===true,'actual completed clock model required');
 need(typeof input.jobStartedUTCNs==='bigint'&&typeof input.jobCompletedUTCNs==='bigint'&&input.jobStartedUTCNs>0n&&input.jobStartedUTCNs<=input.jobCompletedUTCNs,'actual finite ordered job window required');
 const value=Object.freeze({startedUTCNs:decimal(r.startedUTCNs),completedUTCNs:decimal(r.completedUTCNs),startedMonotonicNs:decimal(r.startedMonotonicNs),completedMonotonicNs:decimal(r.completedMonotonicNs),outerParentDeadlineMonotonicNs:decimal(r.outerParentDeadlineMonotonicNs),operationDeadlineMonotonicNs:decimal(r.operationDeadlineMonotonicNs)});
 need(input.jobStartedUTCNs<=value.startedUTCNs&&value.startedUTCNs<=value.completedUTCNs&&value.completedUTCNs<=input.jobCompletedUTCNs,'actual UTC completion outside private job window');
 need(value.startedMonotonicNs<=value.completedMonotonicNs&&value.startedMonotonicNs<value.operationDeadlineMonotonicNs&&value.completedMonotonicNs<=value.operationDeadlineMonotonicNs&&value.operationDeadlineMonotonicNs<=value.outerParentDeadlineMonotonicNs,'actual monotonic completion outside original parent intersection');
 if(p)need(p.completedUTCNs<=value.startedUTCNs&&p.completedMonotonicNs<=value.startedMonotonicNs&&p.outerParentDeadlineMonotonicNs===value.outerParentDeadlineMonotonicNs,'causal ordering or same original outer deadline differs');
 return value;
}
