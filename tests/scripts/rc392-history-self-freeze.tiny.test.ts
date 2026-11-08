/** RC392 F1 regression: the immediately-preceding published generation must stay frozen.
 *
 *  consumer[106] / ci[216] / ci[217] were CURRENT at the published base 56ac962 and are
 *  history now. They bind the two controller modules through LIVE tag-5 nodes, so their
 *  whole-group aggregates would silently follow the current policy/canonical bytes. These
 *  constants are the REAL whole-group hashes of the git-56 module closure (not a
 *  normalised self-role view, not a copied literal), so the assertion fails if the
 *  generation starts tracking the live files.
 *
 *  The CURRENT tail is deliberately NOT frozen: it must keep binding the actual final
 *  policy and canonical bytes, and that is asserted separately below. */
import {describe, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import * as c from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {sourceBindingKey, selectGitHubSourceBindingGroup}
  from '../../scripts/lib/independent-admission/github-source-binding-groups';

const whole = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const rowsOf = (g: any) => [...(g.selectors ?? []), ...(g.secondarySelectors ?? []),
  ...(g.secondarySelectorStages ?? []).flat(), ...(g.sourceBindings ?? [])];

/** Whole-group aggregates captured from the actual git 56ac962 closure. */
const PUBLISHED_56 = {
  consumer106: '6d665ba1009dfbd5e45917d8cba59b065f853658a2b7577300d648d180682b2a',
  ci216: '7e973b5bd7d38a5b84cbbf745d109013119e45582f5c394393c1804f924e99db',
  ci217: '012625b0ce74a743c3811dfe804482dab0b04b040b1d0dbe251497b732bd8629',
} as const;

/** The controller bytes that generation actually shipped with. */
const PUBLISHED_56_POLICY = '85f790b5a3754ff63301deb6f78be29f2b3ced4b8c6cf799f7f9144630b45b45';
const PUBLISHED_56_CANON = '9bd3d277d0644d8de982398a70805b23251edc183834253810c9001b80e9fc65';

describe('RC392: the preceding published generation is frozen', () => {
  test('consumer[106] still equals its published git-56 whole-group aggregate', () => {
    expect(whole(c.CONSUMER_SOURCE_GROUPS[106]!)).toBe(PUBLISHED_56.consumer106);
  });

  test('ci[216] and ci[217] still equal their published git-56 aggregates', () => {
    expect(whole(c.CI_CONSUMER_SOURCE_GROUPS[216]!)).toBe(PUBLISHED_56.ci216);
    expect(whole(c.CI_CONSUMER_SOURCE_GROUPS[217]!)).toBe(PUBLISHED_56.ci217);
  });

  test('those groups declare the controller originals they shipped with', () => {
    for (const grp of [c.CONSUMER_SOURCE_GROUPS[106]!, c.CI_CONSUMER_SOURCE_GROUPS[216]!,
      c.CI_CONSUMER_SOURCE_GROUPS[217]!]) {
      const rows = rowsOf(grp) as readonly any[];
      expect(rows.some(r => r.path?.endsWith('consumer-observer-policy.ts')
        && r.sha256 === PUBLISHED_56_POLICY)).toBe(true);
      expect(rows.some(r => r.path?.endsWith('consumer-execution-current.json')
        && r.sha256 === PUBLISHED_56_CANON)).toBe(true);
    }
  });
});

describe('RC392: the CURRENT tail still binds the live controller bytes', () => {
  test('the newest generation is NOT frozen to the published values', () => {
    const tail = c.CONSUMER_SOURCE_GROUPS.at(-1) as any;
    const rows = rowsOf(tail) as readonly any[];
    const live = new Set(c.CONTROLLER_POLICY_BINDINGS.map(b => b.path));
    for (const path of live) {
      const row = rows.find(r => r.path === path);
      expect(row).toBeDefined();
      const binding = c.CONTROLLER_POLICY_BINDINGS.find(b => b.path === path)!;
      expect(row.sha256).toBe(binding.sha256);
    }
    // ...and it is a different aggregate from the frozen predecessor.
    expect(whole(tail)).not.toBe(PUBLISHED_56.consumer106);
  });

  test('the freeze adds no axis; the published 108/220 prefix stays and current tails follow', () => {
    // The RC392 freeze itself is append-only: the published 56 prefix (consumer 106 /
    // CI 216-217) is asserted above by whole hash. These are the CURRENT totals after
    // the later RC393 appends, so they legitimately advance with the live tail.
    expect(c.CONSUMER_SOURCE_GROUPS.length).toBe(109);
    expect(c.CI_CONSUMER_SOURCE_GROUPS.length).toBe(222);
    // ...and the published prefix is still exactly 108 / 220 groups long.
    expect(c.CONSUMER_SOURCE_GROUPS.length - 1).toBe(108);
    expect(c.CI_CONSUMER_SOURCE_GROUPS.length - 2).toBe(220);
  });
});

describe('RC392: selection semantics survive the freeze', () => {
  test('the current tail self-selects and a complete historical observation selects history', () => {
    for (const [family, index] of [[c.CONSUMER_SOURCE_GROUPS, 106],
      [c.CI_CONSUMER_SOURCE_GROUPS, 216], [c.CI_CONSUMER_SOURCE_GROUPS, 217]] as const) {
      const historical = family[index]!;
      const observed = new Map((rowsOf(historical) as readonly any[])
        .map(r => [sourceBindingKey(r), r.sha256]));
      expect(selectGitHubSourceBindingGroup(family, observed)).toBe(historical);
    }
    for (const family of [c.CONSUMER_SOURCE_GROUPS, c.CI_CONSUMER_SOURCE_GROUPS]) {
      const tail = family.at(-1)!;
      const observed = new Map((rowsOf(tail) as readonly any[])
        .map(r => [sourceBindingKey(r), r.sha256]));
      expect(selectGitHubSourceBindingGroup(family, observed)).toBe(tail);
    }
  });

  test('mixed or missing controller evidence never promotes the CURRENT tail', () => {
    // Selection filters only on owned roles, so a contradictory/hollow context may still
    // resolve to the historical group itself. What must NEVER happen is that it silently
    // selects the newer CURRENT generation whose bytes were not observed.
    const family = c.CONSUMER_SOURCE_GROUPS;
    const historical = family[106]!;
    const tail = family.at(-1)!;
    const base = new Map((rowsOf(historical) as readonly any[])
      .map(r => [sourceBindingKey(r), r.sha256]));

    const mixed = new Map(base);
    mixed.set(sourceBindingKey({path: 'scripts/lib/independent-admission/consumer-observer-policy.ts', sha256: ''} as any),
      c.CONTROLLER_POLICY_BINDINGS[0]!.sha256);
    const mixedPick = (() => { try { return selectGitHubSourceBindingGroup(family, mixed); } catch { return undefined; } })();
    expect(mixedPick).not.toBe(tail);

    const missing = new Map(base);
    missing.delete(sourceBindingKey({path: 'scripts/lib/independent-admission/consumer-execution-current.json', sha256: ''} as any));
    const missingPick = (() => { try { return selectGitHubSourceBindingGroup(family, missing); } catch { return undefined; } })();
    expect(missingPick).not.toBe(tail);
  });
});
