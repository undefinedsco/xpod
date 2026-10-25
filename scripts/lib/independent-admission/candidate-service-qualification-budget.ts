import {performance} from 'node:perf_hooks';
import limits from '../module-artifact-limits.json';
import {nativeOriginalsView,assertCollectedNativeOriginalCustody} from './native-original-collector';
import {isCandidateServiceImageGitHubOrigin} from './github-origin';

/** One receiver instance, created after acquisition and shared by every axis.
 * Reservations account for material copies/staging; logical reads account for
 * returned bytes, including decoded bytes. They are different resources.
 * Neither replaces the collector's existing encoded IO/range/time limits or
 * the producer's physical retained-original ledger.
 */
export interface CandidateServiceQualificationBudget {
  check(): void;
  remainingMs(): number;
  reserveBytes(bytes: number): void;
  chargeReadBytes(bytes: number): void;
  remainingReadBytes(): number;
  remainingOriginalBytes():number;
  reserveOriginalMaximum(maximum:number):object;
  settleOriginalReservation(token:object,actual:number,unusedOriginalsAbsent:boolean):void;
}

/** The global logical-read ceiling is an additional stricter observation bound
 * using the existing source-material declaration. No axis receives a new
 * allocation or can replenish either monotonic counter.
 */
export function createCandidateServiceQualificationBudget(serviceOriginals?:unknown): CandidateServiceQualificationBudget {
  const deadline = performance.now() + limits.timeoutMs;
  let reserved = 0, read = 0, physical = 0;
  const originalTokens=new WeakMap<object,number>();
  const native=serviceOriginals===undefined?undefined:nativeOriginalsView(serviceOriginals);
  if(serviceOriginals!==undefined&&(!native||!isCandidateServiceImageGitHubOrigin(native.origin)))throw Error('Candidate service qualification budget: genuine service original universe required');
  if(native){assertCollectedNativeOriginalCustody(serviceOriginals);physical=native.members.reduce((total,row)=>total+row.bytes,0);if(!Number.isSafeInteger(physical)||physical<0||physical>32*limits.metadataBytes)throw Error('Candidate service qualification budget: retained original universe exceeds existing bound');}
  let failure: Error | undefined;
  const fail = (reason: string): never => {
    failure ??= Error('Candidate service qualification budget: ' + reason);
    throw failure;
  };
  const check = () => {
    if (failure) throw failure;
    if (performance.now() >= deadline) fail('shared observation deadline expired');
  };
  const charge = (bytes: number, spent: number, resource: string) => {
    check();
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limits.sourceMaterialBytes - spent) {
      fail('shared ' + resource + ' bound exceeded');
    }
    return spent + bytes;
  };
  return Object.freeze({
    check,
    remainingMs() { return failure ? 0 : Math.max(0, deadline - performance.now()); },
    reserveBytes(bytes: number) { reserved = charge(bytes, reserved, 'material reservation'); },
    chargeReadBytes(bytes: number) { read = charge(bytes, read, 'logical read'); },
    remainingReadBytes() { check(); return limits.sourceMaterialBytes - read; },
    remainingOriginalBytes(){check();if(!native)fail('genuine service original universe required for physical balance');assertCollectedNativeOriginalCustody(serviceOriginals);return 32*limits.metadataBytes-physical;},
    reserveOriginalMaximum(maximum:number){
      check();if(!native)fail('genuine service original universe required for physical reservation');
      assertCollectedNativeOriginalCustody(serviceOriginals);
      if(!Number.isSafeInteger(maximum)||maximum<0||maximum>32*limits.metadataBytes-physical)fail('existing shared retained original bound exceeded');
      const token=Object.freeze({});physical+=maximum;originalTokens.set(token,maximum);return token;
    },
    settleOriginalReservation(token:object,actual:number,unusedOriginalsAbsent:boolean){
      check();if(!native)fail('genuine service original universe required for settlement');
      assertCollectedNativeOriginalCustody(serviceOriginals);const maximum=originalTokens.get(token);
      if(maximum===undefined)return fail('same physical reservation and absent unused originals required');
      if(unusedOriginalsAbsent!==true||!Number.isSafeInteger(actual)||actual<0||actual>maximum)fail('same physical reservation and absent unused originals required');
      originalTokens.delete(token);physical-=maximum-actual;
    },
  });
}
