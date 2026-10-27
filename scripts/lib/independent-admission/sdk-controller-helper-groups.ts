/** Pure exact controller-byte tuple selection; no original capability issuer. */
// Historical whole tuples, plus the appended CURRENT catalogues that the real
// current helper bytes require. The observed PER-TUPLE role bound stays 32; only
// the declared VERSION count grows, and only to the exact real maximum created by
// a genuine append. This is a catalogue length, never a capture capacity.
//
// 39 is the exact genuine maximum: the fetch CURRENT catalogue holds 39 whole
// tuples after the SDK86 metadata/ownership append. It is the declared VERSION
// count only - it is not an artifact, capture, per-tuple, time or budget bound.
const MAXIMUM_DECLARED_HELPER_GROUPS = 39;
const MAXIMUM_OBSERVED_HELPERS = 32;
const DIFFERS = 'SDK controller complete helper group differs';

/** Shared declaration/observation validation for every consumer. */
function assertHelperScope(groups: readonly (readonly (readonly [string, string])[])[], observed: ReadonlyMap<string, string>): void {
  if (!groups.length || groups.length > MAXIMUM_DECLARED_HELPER_GROUPS || observed.size > MAXIMUM_OBSERVED_HELPERS) throw Error(DIFFERS);
}

/** The required-name precondition, extracted once and called by both the strict
 * selector and the names planner so the two can never drift. */
function assertRequiredObservations(requiredNames: readonly string[], observed: ReadonlyMap<string, string>): void {
  if (!requiredNames.length || requiredNames.length > MAXIMUM_OBSERVED_HELPERS
      || new Set(requiredNames).size !== requiredNames.length
      || observed.size !== requiredNames.length
      || !requiredNames.every(name => observed.has(name))) throw Error(DIFFERS);
}

/** A declared tuple is usable only when its role names are unique and it stays
 * inside the per-tuple observation bound. */
function usable(group: readonly (readonly [string, string])[]): boolean {
  return group.length <= MAXIMUM_OBSERVED_HELPERS && new Set(group.map(([name]) => name)).size === group.length;
}

/** A group is a viable candidate only when EVERY required/observed role is present
 * in it with the matching digest. A disjoint group that merely omits a known role
 * is NOT viable. Pure: reads nothing, grants nothing. */
function candidateCandidates(groups: readonly (readonly (readonly [string, string])[])[], required: readonly (readonly [string, string])[]): readonly (readonly (readonly [string, string])[])[] {
  return groups.filter(group => usable(group)
    && required.every(([name, sha]) => group.some(([role, digest]) => role === name && digest === sha)));
}

export function selectSdkControllerHelperGroup(groups: readonly (readonly (readonly [string, string])[])[], observed: ReadonlyMap<string, string>): readonly (readonly [string, string])[] {
  assertHelperScope(groups, observed);
  const matches = groups.filter(group => group.length === observed.size
    && group.length === new Set(group.map(([name]) => name)).size
    && group.every(([name, sha]) => observed.get(name) === sha));
  if (matches.length !== 1) throw Error(DIFFERS);
  return matches[0]!;
}

/** Resolve declared additional imports only after the complete common tuple
 * uniquely identifies a reviewed group. The final full tuple is still checked by
 * selectSdkControllerHelperGroup after every additional original is read. */
export function requiredSdkControllerHelperGroup(groups: readonly (readonly (readonly [string, string])[])[], requiredNames: readonly string[], observed: ReadonlyMap<string, string>): readonly (readonly [string, string])[] {
  assertHelperScope(groups, observed);
  assertRequiredObservations(requiredNames, observed);
  const matches = groups.filter(group => usable(group)
    && requiredNames.every(name => group.some(([role, sha]) => role === name && observed.get(name) === sha)));
  if (matches.length !== 1) throw Error(DIFFERS);
  return matches[0]!;
}

/** Pure helper-name plan: the bounded union of additional role NAMES that any
 * still-viable declared candidate may request.
 *
 * A fresh tuple appended after an older one that agrees on the already observed
 * prefix can leave MORE THAN ONE viable candidate, so demanding a unique partial
 * match would refuse a real current graph. The plan therefore unions the
 * additional names across every viable candidate; the caller reads exactly those
 * names once and the exact selector still requires one complete group.
 *
 * A viable candidate that is already complete needs no extra import: the plan is
 * `[]` and the caller proceeds straight to the exact selection. No capability and
 * no authority is created here; the caller's own custody checks still run.
 */
export function requiredSdkControllerHelperNames(groups: readonly (readonly (readonly [string, string])[])[], requiredNames: readonly string[], observed: ReadonlyMap<string, string>): readonly string[] {
  assertHelperScope(groups, observed);
  assertRequiredObservations(requiredNames, observed);
  const observedRows = requiredNames.map(name => [name, observed.get(name)!] as const);
  const candidates = candidateCandidates(groups, observedRows);
  if (!candidates.length) throw Error(DIFFERS);
  const names: string[] = [];
  for (const group of candidates) {
    for (const [name] of group) {
      if (observed.has(name) || names.includes(name)) continue;
      names.push(name);
    }
  }
  // An empty plan is a SUCCESS: every viable candidate is already fully known.
  if (names.length + observed.size > MAXIMUM_OBSERVED_HELPERS) throw Error(DIFFERS);
  return Object.freeze(names);
}
