import limits from '../module-artifact-limits.json';
import type {NativeArchiveObservationBudget} from './native-originals';
/** Every archive verification shares the caller's remaining operation budget.
 * Omitting it preserves the original scanner limit; it can never raise it. */
export function nativeArchiveInspectionTimeout(budget?:NativeArchiveObservationBudget):number {
 if(!budget)return limits.timeoutMs;
 budget.check();
 const remaining=budget.remainingMs();
 if(!Number.isFinite(remaining)||remaining<1)throw Error('Native original custody: observation deadline expired');
 return Math.min(limits.timeoutMs,Math.floor(remaining));
}
