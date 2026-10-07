import { describe, expect, it } from 'vitest';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';

describe('sync cursor token contract', () => {
  async function harness(): Promise<{ store: any; context: any; room: any; token: string }> {
    const { store, context } = matrixHarness();
    const room = await store.createRoom({}, context);
    const token = (await store.sync(context, { limit: 10 })).next_batch as string;
    return { store, context, room, token };
  }

  it('bootstraps a bounded opaque v3 cursor and rejects a legacy numeric token', async() => {
    const { store, context, token } = await harness();
    expect(token).toMatch(/^v3\.[0-9a-f-]{36}\.\d+\.\d+$/u);
    expect(token.length).toBeLessThanOrEqual(128);
    await expect(store.sync(context, { since: 'v2_5' })).rejects.toMatchObject({ status: 400 });
  });

  it('rejects malformed and oversized cursor tokens instead of silently bootstrapping', async() => {
    const { store, context, token } = await harness();
    for (const bad of [ 'nonsense', 'v3.short.1.1', 'v3.' + 'a'.repeat(200) + '.1.1', `v3.${'0'.repeat(36)}.5.9` ]) {
      await expect(store.sync(context, { since: bad })).rejects.toMatchObject({ status: 400 });
    }
    // A valid token with position <= through still works.
    await expect(store.sync(context, { since: token, limit: 5 })).resolves.toHaveProperty('next_batch');
  });

  it('rejects a non-positive or non-integer limit', async() => {
    const { store, context, token } = await harness();
    for (const limit of [ 0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN ]) {
      await expect(store.sync(context, { since: token, limit })).rejects.toMatchObject({ status: 400 });
    }
  });

  it('allows the limit+1 look-ahead row needed to detect more work', async() => {
    // The journal page cap must not truncate the look-ahead row the sync uses for `limited`.
    const { InMemoryMatrixEventJournal } = await import('../../../src/api/matrix/MatrixEventJournal');
    const journal = new InMemoryMatrixEventJournal();
    const scope = 'https://pod.example/alice/';
    for (let index = 0; index < 3; index++) {
      await journal.registerReference(scope, { roomId: '!r', eventId: `$e${index}`, createdAt: index });
    }
    expect(await journal.listReferences(scope, { limit: 1001 })).toHaveLength(3);
  });
});
