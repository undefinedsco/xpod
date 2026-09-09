import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { drizzle as esmDrizzle, SelectQueryBuilder as EsmSelectQueryBuilder } from '@undefineds.co/drizzle-solid';
import { aiProviderResource, credentialResource } from '@undefineds.co/models';

const require = createRequire(import.meta.url);
const { drizzle: cjsDrizzle, SelectQueryBuilder: CjsSelectQueryBuilder } = require('@undefineds.co/drizzle-solid') as {
  drizzle: typeof esmDrizzle;
  SelectQueryBuilder: typeof EsmSelectQueryBuilder;
};

describe('drizzle-solid browser runtime compatibility', () => {
  it.each([
    ['ESM', esmDrizzle],
    ['CJS', cjsDrizzle],
  ] as const)('%s constructs the real database without a Node process or a clientId', (_format, drizzle) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process')!;
    let result: unknown;
    let failure: unknown;
    try {
      Object.defineProperty(globalThis, 'process', { configurable: true, value: undefined });
      result = drizzle({
        info: { isLoggedIn: true, webId: 'https://id.example/alice/profile/card#me' },
        fetch: globalThis.fetch,
      } as Parameters<typeof drizzle>[0], {
        podUrl: 'https://local.nodes.example/alice/',
        schema: { aiProvider: aiProviderResource, credential: credentialResource },
        autoConnect: false,
        resourcePreparation: 'off',
      });
    } catch (error) {
      failure = error;
    } finally {
      Object.defineProperty(globalThis, 'process', descriptor);
    }
    if (failure) throw failure;
    expect(result).toBeDefined();
  });

  it.each([
    ['ESM', EsmSelectQueryBuilder],
    ['CJS', CjsSelectQueryBuilder],
  ] as const)('%s processes non-empty SELECT results without a Node process', async (_format, SelectQueryBuilder) => {
    const row = { '@id': 'https://local.nodes.example/alice/settings/providers/deepseek.ttl#this' };
    const session = { execute: async () => [row] } as unknown as ConstructorParameters<typeof SelectQueryBuilder>[0];
    const query = new SelectQueryBuilder(session).from(aiProviderResource);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process')!;
    let result: unknown;
    let failure: unknown;
    try {
      Object.defineProperty(globalThis, 'process', { configurable: true, value: undefined });
      result = await query.execute();
    } catch (error) {
      failure = error;
    } finally {
      Object.defineProperty(globalThis, 'process', descriptor);
    }
    if (failure) throw failure;
    expect(result).toEqual([expect.objectContaining(row)]);
  });
});
