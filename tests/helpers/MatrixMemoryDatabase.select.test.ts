import { describe, expect, it } from 'vitest';
import { messageResource } from '@undefineds.co/models';
import { alias, and, asc, desc, eq, gt, or } from '@undefineds.co/drizzle-solid';
import { matrixHarness } from './MatrixMemoryDatabase';

/**
 * The in-memory database must honor the public query semantics the cursor adapter relies on:
 * `where`, ordered `orderBy`, `limit` and composite `whereCursor` must really change the row set,
 * not silently no-op.
 */
describe('matrix memory database select semantics', () => {
  it('reads a public scoped alias from canonical rows without changing their subjects', async() => {
    const { db, rows } = matrixHarness();
    const base = 'https://pod.example/alice/.data/chat/scoped/';
    const table = alias(messageResource, 'scoped').$schema.table('scoped', {
      base, resourceMode: 'sparql', sparqlEndpoint: `${base}-/sparql`, autoRegister: false,
    });
    rows.set(messageResource, [
      { id: 'first', '@id': `${base}2026/10/03/messages.ttl#a`, createdAt: '2026-10-03T00:00:00Z' },
      { id: 'older', '@id': `${base}2026/09/25/messages.ttl#b`, createdAt: '2026-09-25T00:00:00Z' },
      { id: 'foreign', '@id': 'https://pod.example/alice/.data/chat/other/messages.ttl#c', createdAt: '2000-01-01T00:00:00Z' },
    ]);
    const result = await db.select().from(table).orderBy(asc('createdAt'), asc('id')).limit(2);
    expect(result.map((row: any) => row['@id'])).toEqual([
      `${base}2026/09/25/messages.ttl#b`, `${base}2026/10/03/messages.ttl#a`,
    ]);
    expect(rows.get(messageResource)).toHaveLength(3);
  });
  it('uses public composite cursors, datetime instants and full subject ordering', async() => {
    const { db, rows } = matrixHarness();
    const document = 'https://pod.example/alice/source.ttl';
    rows.set(messageResource, [
      { id: 'z', '@id': `${document}#A`, parent: 'p', createdAt: '2000-01-01T01:00:00+01:00' },
      { id: 'a', '@id': `${document}#B`, parent: 'p', createdAt: '2000-01-01T00:00:00Z' },
      { id: 'b', '@id': `${document}#C`, parent: 'p', createdAt: '2000-01-02T00:00:00Z' },
    ]);
    const at = new Date('2000-01-01T00:00:00Z');
    const result = await db.select().from(messageResource).where(eq(messageResource.parent, 'p'))
      .whereCursor(or(gt(messageResource.createdAt, at),
        and(eq(messageResource.createdAt, at), gt(messageResource.id, `${document}#A`))))
      .orderBy(asc('createdAt'), asc('id')).limit(2);
    expect(result.map((row: any) => row['@id'])).toEqual([`${document}#B`, `${document}#C`]);
    const reverse = await db.select().from(messageResource).orderBy(desc('createdAt'), desc('id')).limit(3);
    expect(reverse.map((row: any) => row['@id'])).toEqual([`${document}#C`, `${document}#B`, `${document}#A`]);
  });

  it('hydrates a source identity without modifying the stored exemplar', async() => {
    const { db, rows, context } = matrixHarness();
    const row = { id: 'fixture-original', parent: 'p', createdAt: '2000-01-01T00:00:00Z' };
    rows.set(messageResource, [row]);
    const [hydrated] = await db.select().from(messageResource);
    expect(hydrated['@id']).toBe(messageResource.buildIri(context.podUrl, { id: row.id }));
    expect(row).not.toHaveProperty('@id');
    expect(hydrated).not.toBe(row);
  });
  it('applies where, orderBy, limit and range conditions to the row set', async() => {
    const { db } = matrixHarness();
    const rows = [
      { id: 'a', parent: 'p', createdAt: '2026-01-03T00:00:00Z' },
      { id: 'b', parent: 'p', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'c', parent: 'p', createdAt: '2026-01-02T00:00:00Z' },
      { id: 'd', parent: 'q', createdAt: '2026-01-01T00:00:00Z' },
    ];
    (db as any).insert(messageResource);
    for (const row of rows) {
      await (db as any).insert(messageResource).values(row);
    }
    const ordered = await (db as any).select().from(messageResource)
      .where(eq(messageResource.parent as never, 'p'))
      .orderBy({ name: 'createdAt' } as never)
      .orderBy({ name: 'id' } as never)
      .limit(2);
    expect(ordered.map((row: any) => row.id)).toEqual([ 'b', 'c' ]);
    // The limit is a real bound, and the parent filter excludes the other room.
    expect((await (db as any).select().from(messageResource).where(eq(messageResource.parent as never, 'p')).limit(10))
      .map((row: any) => row.id)).toHaveLength(3);
    // A composite range condition (cursor) filters rows after a position.
    const cursor = await (db as any).select().from(messageResource)
      .where(eq(messageResource.parent as never, 'p'))
      .whereCursor({ operator: '>', left: { name: 'createdAt' }, right: '2026-01-01T00:00:00Z' } as never)
      .orderBy({ name: 'createdAt' } as never)
      .limit(10);
    expect(cursor.map((row: any) => row.id)).toEqual([ 'c', 'a' ]);
  });
});
