import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { EdgeNodeRepository } from '../../src/identity/drizzle/EdgeNodeRepository';
import { executeQuery, getIdentityDatabase } from '../../src/identity/drizzle/db';

/**
 * N07: reachability state lives inside `cluster_node.metadata`, where the old
 * read-modify-write dropped whatever another writer committed in between. The swap is the
 * primitive that makes those writes safe, so it is tested against a real SQLite database
 * rather than a mocked driver: a mock cannot show whether the WHERE clause works.
 */
function createRepo(): { repository: EdgeNodeRepository } {
  const db = getIdentityDatabase(`sqlite::memory:metadata-cas-${Date.now()}-${Math.random()}`);
  return { repository: new EdgeNodeRepository(db) };
}

describe('EdgeNodeRepository metadata compare-and-swap (N07)', () => {
  it('applies a write whose expectation still matches the stored metadata', async () => {
    const { repository } = createRepo();
    const { nodeId } = await repository.createNode('cas-apply');

    const current = await repository.getNodeMetadata(nodeId);
    expect(current?.metadata).toBeNull();

    const applied = await repository.updateNodeMetadataAtomic(nodeId, null, { reachability: { stage: 'ready' } });

    expect(applied).toBe(true);
    expect((await repository.getNodeMetadata(nodeId))?.metadata).toEqual({ reachability: { stage: 'ready' } });
  });

  it('rejects a stale write instead of overwriting the concurrent one', async () => {
    const { repository } = createRepo();
    const { nodeId } = await repository.createNode('cas-stale');

    // Two readers see the same snapshot; the first one wins.
    const snapshot = (await repository.getNodeMetadata(nodeId))?.metadata ?? null;
    expect(await repository.updateNodeMetadataAtomic(nodeId, snapshot, { winner: 'first' })).toBe(true);
    expect(await repository.updateNodeMetadataAtomic(nodeId, snapshot, { winner: 'second' })).toBe(false);

    expect((await repository.getNodeMetadata(nodeId))?.metadata).toEqual({ winner: 'first' });
  });

  it('lets exactly one of two concurrent swaps win', async () => {
    const { repository } = createRepo();
    const { nodeId } = await repository.createNode('cas-concurrent');
    const snapshot = (await repository.getNodeMetadata(nodeId))?.metadata ?? null;

    const [ first, second ] = await Promise.all([
      repository.updateNodeMetadataAtomic(nodeId, snapshot, { winner: 'a' }),
      repository.updateNodeMetadataAtomic(nodeId, snapshot, { winner: 'b' }),
    ]);

    expect([ first, second ].filter(Boolean)).toHaveLength(1);
    const stored = (await repository.getNodeMetadata(nodeId))?.metadata as { winner?: string };
    expect([ 'a', 'b' ]).toContain(stored.winner);
  });

  it('does not invent a success when the node does not exist', async () => {
    const { repository } = createRepo();
    expect(await repository.updateNodeMetadataAtomic('missing-node', null, { any: true })).toBe(false);
  });

  it('leaves the stored metadata untouched when the swap loses', async () => {
    const { repository } = createRepo();
    const { nodeId } = await repository.createNode('cas-untouched');
    await repository.updateNodeMetadataAtomic(nodeId, null, { reachabilitySessions: { p2p: [ 'kept' ] } });

    const stale = null;
    expect(await repository.updateNodeMetadataAtomic(nodeId, stale, { reachabilitySessions: { p2p: [] } })).toBe(false);

    const stored = (await repository.getNodeMetadata(nodeId))?.metadata as {
      reachabilitySessions?: { p2p?: string[] };
    };
    expect(stored.reachabilitySessions?.p2p).toEqual([ 'kept' ]);
  });
});

/** Guards the assumption the swap relies on: stored payloads round-trip byte-identically. */
describe('EdgeNodeRepository metadata serialization', () => {
  it('round-trips the stored payload so a serialized comparison is meaningful', async () => {
    const { repository } = createRepo();
    const { nodeId } = await repository.createNode('cas-roundtrip');
    const db = (repository as unknown as { db: ReturnType<typeof getIdentityDatabase> }).db;

    const payload = { reachabilitySessions: { p2p: [ { sessionId: 'p2p_1', candidates: [ { host: 'a' } ] } ] } };
    await repository.updateNodeMetadataAtomic(nodeId, null, payload);

    const rows = await executeQuery<{ metadata: string }>(db, sql`
      SELECT metadata FROM cluster_node WHERE id = ${nodeId} LIMIT 1
    `);
    const storedText = String(rows.rows[0]?.metadata);
    expect(JSON.stringify(JSON.parse(storedText))).toBe(storedText);
  });
});
