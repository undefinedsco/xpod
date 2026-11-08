/** RC393: the merged 7a8408d5 staging tree PUBLISHED consumer[0..107] and CI[0..219].
 *  Their whole-group aggregates must stay byte-identical: a later append to the live
 *  policy/canonical must never rewrite published history.
 *
 *  The constants below are the REAL whole-group aggregates of the 7a84 module closure,
 *  computed from git. They are compared as a WHOLE PREFIX, so the assertion fails on the
 *  pre-freeze tree (where the last published groups tracked the live controller files)
 *  and passes after the freeze. No self-normalisation, no `at(-1)` shortcut.
 *
 *  Note: OLDER published groups legitimately pin their OWN era's controller bytes, so the
 *  correct invariant is prefix equality, not one uniform value across all of history. */
import {test, expect} from 'bun:test';
import {createHash} from 'node:crypto';
import * as c from '../../scripts/lib/independent-admission/consumer-observer-policy';

const whole = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const rowsOf = (g: any) => [...(g.selectors ?? []), ...(g.secondarySelectors ?? []),
  ...(g.secondarySelectorStages ?? []).flat(), ...(g.sourceBindings ?? [])];

/** The controller bytes the last published generation actually shipped with at 7a8408d5. */
const PUBLISHED_POLICY = '1668f7c1acddd17adf3102ee4dc377107a492aa5fa22be72fb6c87eda1441c38';
const PUBLISHED_CANON = '67e16e45448a48df8ccce1cffaf586284a625a0ecb58df68ee660e5f45345481';

/** Real whole-prefix aggregates of the 7a84 closure. */
const BASE_7A84 = {
  consumerPrefix: '64c2433e373bf1cade88818b526373c834289e6a73adccec830c045cb3f7ed6b',
  ciPrefix: 'aa8f2583f4c4404e6a6e81ad47bd5b904745e16af51115495bff3c03d5d310fd',
  consumer107: 'f8b80046f844ccb2b053b4a316c83eb13be4f08ebb7e30401422e6afcd63e03a',
  ci218: '8af5b4c8d12431a906ba7dfe404a308ee70c56c1052d2f14e075fb786290d60a',
  ci219: 'eb67de4707dae50bc17239d3210265d17cd5747779c0f6fea26cac3c45d86bd9',
} as const;

test('the whole published consumer prefix equals its 7a84 aggregate', () => {
  expect(c.CONSUMER_SOURCE_GROUPS.length).toBe(109); // 108 published + 1 appended
  expect(whole(c.CONSUMER_SOURCE_GROUPS.slice(0, 108))).toBe(BASE_7A84.consumerPrefix);
});

test('the whole published CI prefix equals its 7a84 aggregate', () => {
  expect(c.CI_CONSUMER_SOURCE_GROUPS.length).toBe(222); // 220 published + the appended pair
  expect(whole(c.CI_CONSUMER_SOURCE_GROUPS.slice(0, 220))).toBe(BASE_7A84.ciPrefix);
});

test('the drifted published tails carry the 7a84 controller bytes', () => {
  expect(whole(c.CONSUMER_SOURCE_GROUPS[107]!)).toBe(BASE_7A84.consumer107);
  expect(whole(c.CI_CONSUMER_SOURCE_GROUPS[218]!)).toBe(BASE_7A84.ci218);
  expect(whole(c.CI_CONSUMER_SOURCE_GROUPS[219]!)).toBe(BASE_7A84.ci219);
  for (const grp of [c.CONSUMER_SOURCE_GROUPS[107]!, c.CI_CONSUMER_SOURCE_GROUPS[218]!,
    c.CI_CONSUMER_SOURCE_GROUPS[219]!]) {
    const rows = rowsOf(grp) as readonly any[];
    expect(rows.some(r => r.path?.endsWith('consumer-observer-policy.ts')
      && r.sha256 === PUBLISHED_POLICY)).toBe(true);
    expect(rows.some(r => r.path?.endsWith('consumer-execution-current.json')
      && r.sha256 === PUBLISHED_CANON)).toBe(true);
  }
});

test('the newly appended generation is still LIVE, not frozen to published bytes', () => {
  const tail = c.CONSUMER_SOURCE_GROUPS.at(-1) as any;
  const rows = rowsOf(tail) as readonly any[];
  for (const binding of c.CONTROLLER_POLICY_BINDINGS) {
    const row = rows.find((r: any) => r.path === binding.path);
    expect(row).toBeDefined();
    expect(row.sha256).toBe(binding.sha256);
  }
  expect(whole(tail)).not.toBe(BASE_7A84.consumer107);
});
