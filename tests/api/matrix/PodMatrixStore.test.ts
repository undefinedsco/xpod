import { describe, expect, it, vi } from 'vitest';
import { PodMatrixStore } from '../../../src/api/matrix';

const { db } = vi.hoisted(() => ({
  db: createDb(),
}));

vi.mock('@undefineds.co/drizzle-solid', async () => {
  const actual = await vi.importActual<typeof import('@undefineds.co/drizzle-solid')>('@undefineds.co/drizzle-solid');
  return {
    ...actual,
    drizzle: vi.fn(() => db),
  };
});

function createDb(): any {
  return {
    init: vi.fn(async () => undefined),
    findById: vi.fn(async () => ({ id: 'rooms/~21room~3Aexample.com/index.ttl#this' })),
    insert: vi.fn(() => ({
      values: vi.fn(async () => undefined),
    })),
    select: vi.fn(() => createSelectQuery([])),
  };
}

function createSelectQuery(result: unknown[]): any {
  const query: any = {
    from: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(() => Promise.resolve(result)),
    then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) => (
      Promise.resolve(result).then(resolve, reject)
    ),
  };
  return query;
}

function solidContext() {
  return {
    userId: 'https://alice.example/profile/card#me',
    auth: {
      type: 'solid',
      webId: 'https://alice.example/profile/card#me',
      accessToken: 'token',
      tokenType: 'Bearer',
    } as any,
  };
}

function flattenExpressions(condition: any): any[] {
  if (!condition) {
    return [];
  }
  if (Array.isArray(condition.expressions)) {
    return condition.expressions.flatMap(flattenExpressions);
  }
  return [condition];
}

describe('PodMatrixStore query pushdown', () => {
  it('pushes Matrix message pagination direction into drizzle-solid predicates', async () => {
    const store = new PodMatrixStore({});

    const backwardQuery = createSelectQuery([]);
    db.select.mockReturnValueOnce(backwardQuery);
    await store.listMessages('!room:example.com', solidContext(), {
      from: 's200',
      dir: 'b',
      limit: 10,
    });

    const backwardConditions = flattenExpressions(backwardQuery.where.mock.calls[0][0]);
    expect(backwardConditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ operator: '=', right: '!room:example.com' }),
      expect.objectContaining({ operator: '<=', right: 200 }),
    ]));
    expect(backwardConditions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ operator: '>', right: 200 }),
    ]));
    expect(backwardQuery.orderBy.mock.calls[0][0]).toMatchObject({ direction: 'desc' });
    expect(backwardQuery.limit).toHaveBeenCalledWith(10);

    const forwardQuery = createSelectQuery([]);
    db.select.mockReturnValueOnce(forwardQuery);
    await store.listMessages('!room:example.com', solidContext(), {
      from: 's200',
      dir: 'f',
      limit: 10,
    });

    const forwardConditions = flattenExpressions(forwardQuery.where.mock.calls[0][0]);
    expect(forwardConditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ operator: '=', right: '!room:example.com' }),
      expect.objectContaining({ operator: '>', right: 200 }),
    ]));
    expect(forwardConditions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ operator: '<=', right: 200 }),
    ]));
    expect(forwardQuery.orderBy.mock.calls[0][0].name).toBe('originServerTs');
    expect(forwardQuery.limit).toHaveBeenCalledWith(10);
  });

  it('computes new event depth from the current room max depth only', async () => {
    const store = new PodMatrixStore({});
    const txnQuery = createSelectQuery([]);
    const depthQuery = createSelectQuery([{ depth: 41 }]);
    db.select.mockReturnValueOnce(txnQuery).mockReturnValueOnce(depthQuery);

    const event = await store.sendEvent('!room:example.com', 'm.room.message', 'txn-1', {
      msgtype: 'm.text',
      body: 'hello',
    }, solidContext());

    expect(event.eventId).toMatch(/^\$/);
    expect(depthQuery.where.mock.calls[0][0]).toMatchObject({
      operator: '=',
      right: '!room:example.com',
    });
    expect(depthQuery.orderBy.mock.calls[0][0]).toMatchObject({ direction: 'desc' });
    expect(depthQuery.limit).toHaveBeenCalledWith(1);
    expect(db.insert).toHaveBeenCalled();
  });
});
