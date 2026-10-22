/** Exact timestamp formats emitted by the sole Python supervisor and historical
 * protocol fixtures. Values remain nanoseconds; Date parsing never drops the
 * supervisor's microseconds before the ordering checks. No authority is issued.
 */
function need(value:unknown,reason:string):asserts value{if(!value)throw Error('Service pack parent window: '+reason);}
export function servicePackSupervisorUtc(value:unknown):bigint{
 need(typeof value==='string','actual UTC timestamp string');
 const match=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{3}|\d{6}))?(Z|\+00:00)$/u.exec(value);
 need(match&&(match[3]==='Z'?match[2]?.length===3:match[2]===undefined||match[2].length===6),'exact Python UTC or legacy ISO timestamp');
 const milliseconds=Date.parse(match[1]+'.000Z');need(Number.isSafeInteger(milliseconds)&&new Date(milliseconds).toISOString().slice(0,19)===match[1],'valid actual UTC calendar fields');
 return BigInt(milliseconds)*1000000n+BigInt((match[2]??'').padEnd(9,'0'));
}
export function inspectServicePackParentWindow(input:{receipt:{startedUTC:unknown;closedUTC:unknown};jobStartedMs:number;jobClosedMs:number;deadlineUnixMs:number}){
 need([input.jobStartedMs,input.jobClosedMs,input.deadlineUnixMs].every(Number.isSafeInteger),'integer actual job/deadline time');
 const started=servicePackSupervisorUtc(input.receipt.startedUTC),closed=servicePackSupervisorUtc(input.receipt.closedUTC),deadline=BigInt(input.deadlineUnixMs)*1000000n;
 need(BigInt(input.jobStartedMs)*1000000n<=started&&started<=closed&&closed<=BigInt(input.jobClosedMs)*1000000n&&closed<=deadline&&deadline>started&&deadline-started<=900000000000n,'actual closed job and single 900s parent window');
 return Object.freeze({startedUnixNs:started,closedUnixNs:closed});
}
