import { expect, test } from 'bun:test';
import { checkInventoryFiles } from '../src/module-inventory-workers';

function deferred() {
  let resolve!: () => void; let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
test('inventory workers process every file exactly once with at most four in flight', async () => {
  const items = Array.from({ length: 19 }, (_, i) => i); const seen: number[] = [];
  let active = 0; let peak = 0; const firstBatch = deferred();
  const operation = checkInventoryFiles(items, async item => {
    active++; peak = Math.max(peak, active); seen.push(item);
    if (item < 4) await firstBatch.promise;
    else await Promise.resolve();
    active--;
  });
  expect(seen).toEqual([0, 1, 2, 3]); expect(active).toBe(4);
  firstBatch.resolve(); await operation;
  expect(peak).toBe(4); expect(active).toBe(0);
  expect(seen.sort((a, b) => a - b)).toEqual(items);
});
test('inventory workers stop dispatch on failure, drain all in-flight checks and preserve the original error at the lowest failed index', async () => {
  const gates = Array.from({ length: 4 }, deferred); const started: number[] = []; const finished: number[] = [];
  const original = new Error('original lowest index'); const first = new Error('first observed'); const later = new Error('later'); let settled = false; let caught: unknown;
  const operation = checkInventoryFiles(Array.from({ length: 12 }, (_, i) => i), async item => {
    started.push(item);
    try { await gates[item].promise; } finally { finished.push(item); }
  }).then(() => { settled = true; }, error => { caught = error; settled = true; });
  expect(started).toEqual([0, 1, 2, 3]);
  gates[1].reject(first); await Promise.resolve(); await Promise.resolve();
  expect(settled).toBe(false); expect(started).toEqual([0, 1, 2, 3]);
  gates[0].reject(original); gates[2].reject(later);
  await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false);
  gates[3].resolve(); await operation;
  expect(caught).toBe(original); expect(settled).toBe(true);
  expect(started).toEqual([0, 1, 2, 3]); expect(finished.sort()).toEqual([0, 1, 2, 3]);
});
test('inventory workers handle empty/small lists and synchronous or undefined failures', async () => {
  let calls = 0; await checkInventoryFiles([], async () => { calls++; }); expect(calls).toBe(0);
  await checkInventoryFiles([1, 2], async () => { calls++; }); expect(calls).toBe(2);
  const marker = {}; let caught: unknown;
  try { await checkInventoryFiles([1, 2, 3], () => { throw marker; }); } catch (error) { caught = error; }
  expect(caught).toBe(marker);
  let failed = false;
  try { await checkInventoryFiles([1], async () => { throw undefined; }); } catch (error) { failed = true; expect(error).toBeUndefined(); }
  expect(failed).toBe(true);
});
