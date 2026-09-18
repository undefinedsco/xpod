import { describe, expect, it, beforeEach } from 'vitest';
import { BadRequestHttpError, NotFoundHttpError } from '@solid/community-server';
import { LoginMethodGuardStorage } from '../../src/identity/LoginMethodGuardStorage';

function createMemoryStorage(): any {
  const rows = new Map<string, Map<string, Record<string, unknown>>>();
  let counter = 0;

  const bucket = (type: string): Map<string, Record<string, unknown>> => {
    if (!rows.has(type)) {
      rows.set(type, new Map());
    }
    return rows.get(type)!;
  };

  return {
    defineType: async() => undefined,
    createIndex: async() => undefined,
    create: async(type: string, value: Record<string, unknown>) => {
      const id = `id-${++counter}`;
      bucket(type).set(id, { ...value });
      return { id, ...value };
    },
    has: async(type: string, id: string) => bucket(type).has(id),
    get: async(type: string, id: string) => {
      const value = bucket(type).get(id);
      return value ? { id, ...value } : undefined;
    },
    find: async(type: string, query: Record<string, unknown>) => {
      const matches: any[] = [];
      for (const [id, payload] of bucket(type)) {
        if (Object.entries(query).every(([key, value]) => payload[key] === value)) {
          matches.push({ id, ...payload });
        }
      }
      return matches;
    },
    findIds: async function(this: any, type: string, query: Record<string, unknown>) {
      return (await this.find(type, query)).map((row: any) => row.id);
    },
    set: async(type: string, value: Record<string, unknown>) => {
      const { id, ...rest } = value;
      bucket(type).set(id as string, rest);
    },
    setField: async function(this: any, type: string, id: string, key: string, value: unknown) {
      const current = bucket(type).get(id);
      if (current) {
        current[key] = value;
      }
    },
    delete: async(type: string, id: string) => {
      bucket(type).delete(id);
    },
    entries: async function* (type: string) {
      for (const [id, payload] of bucket(type)) {
        yield { id, ...payload };
      }
    },
  };
}

describe('LoginMethodGuardStorage', () => {
  let inner: ReturnType<typeof createMemoryStorage>;
  let storage: LoginMethodGuardStorage;

  beforeEach(async() => {
    inner = createMemoryStorage();
    storage = new LoginMethodGuardStorage(inner);
    await storage.defineType('account', {}, false);
    await storage.defineType('password', {
      email: 'string',
      password: 'string',
      accountId: 'id:account',
    }, true);
    await storage.defineType('pod', { accountId: 'id:account', baseUrl: 'string' }, false);
  });

  it('blocks deleting the last login method of an account', async() => {
    const account = await storage.create('account', {});
    const password = await storage.create('password', { accountId: account.id, email: 'a@example.com' });

    await expect(storage.delete('password', password.id))
      .rejects.toThrowError(BadRequestHttpError);
    expect(await storage.has('password', password.id)).toBe(true);
  });

  it('allows deleting a login method when another one remains', async() => {
    const account = await storage.create('account', {});
    const first = await storage.create('password', { accountId: account.id, email: 'a@example.com' });
    await storage.create('password', { accountId: account.id, email: 'b@example.com' });

    await storage.delete('password', first.id);
    expect(await storage.has('password', first.id)).toBe(false);
  });

  it('throws NotFoundHttpError when deleting a missing login method', async() => {
    await expect(storage.delete('password', 'missing'))
      .rejects.toThrowError(NotFoundHttpError);
  });

  it('lets passwordless (SP-linked) accounts receive pods', async() => {
    const account = await storage.create('account', {});
    const pod = await storage.create('pod', { accountId: account.id, baseUrl: 'https://sp.example/alice/' });

    expect(pod.id).toBeDefined();
    expect(await storage.has('pod', pod.id)).toBe(true);
  });

  it('does not expire or block accounts without login methods', async() => {
    const account = await storage.create('account', {});
    expect(await storage.has('account', account.id)).toBe(true);
    // 删除账户本身不受登录方法约束
    await storage.delete('account', account.id);
    expect(await storage.has('account', account.id)).toBe(false);
  });

  it('delegates reads and writes to the inner storage', async() => {
    const created = await storage.create('password', { accountId: 'acc-1', email: 'a@example.com' });
    await storage.setField('password', created.id, 'email', 'b@example.com');

    expect(await storage.get('password', created.id)).toMatchObject({ email: 'b@example.com' });
    expect(await storage.findIds('password', { accountId: 'acc-1' })).toEqual([created.id]);

    const entries: any[] = [];
    for await (const entry of storage.entries('password')) {
      entries.push(entry);
    }
    expect(entries).toHaveLength(1);
  });
});
