import { describe, expect, it } from 'vitest';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { aiModelResource, aiProviderDescriptor, aiProviderResource, credentialDescriptor, credentialResource } from '@undefineds.co/models';
import { createPendingWrites, reconcilePendingWrites } from '../src/mutations.js';
import { projectionHash } from '../src/diff.js';
import { createProjectionNormalizer, projectionFieldOrder, writeOnlyFields } from '../src/mapping.js';

const POD = 'https://local.example/alice/';
const database = drizzle({ info: { isLoggedIn: true, webId: 'https://identity.example/alice/card#me' }, fetch }, {
  podUrl: POD, schema: { credential: credentialResource, aiProvider: aiProviderResource }, autoConnect: false,
});
const context = { database, table: credentialResource, descriptor: credentialDescriptor };
const hash = (row: object) => projectionHash(row, projectionFieldOrder(credentialDescriptor));

function confirmation(provider: string, extra: Record<string, unknown> = {}) {
  const local = { id: 'fresh', provider: 'deepseek.ttl', accountLabel: 'Owned new row' };
  const server = { ...local, provider, ...extra };
  const pending = createPendingWrites<Record<string, unknown>>();
  pending.register({ key: 'fresh', intent: local, localRow: local, beforeHash: undefined });
  reconcilePendingWrites(pending, new Map([['fresh', server]]), hash, writeOnlyFields(credentialDescriptor), context);
  return pending;
}

describe('confirmation through the bound ORM URI contract', () => {
  it('confirms the actual relative provider intent against its complete ORM read relation', () => {
    const pending = confirmation(`${POD}settings/providers/deepseek.ttl`);
    expect(pending.isConfirmed('fresh')).toBe(true);
    expect(pending.conflicts).toEqual([]);
  });
  it.each([
    'https://foreign.example/alice/settings/providers/deepseek.ttl',
    'https://local.example/bob/settings/providers/deepseek.ttl',
    `${POD}settings/providers/deepseek.ttl#different`,
    `${POD}settings/providers/openai.ttl`,
  ])('retains a real relationship conflict for %s', (relation) => {
    const pending = confirmation(relation);
    expect(pending.isConfirmed('fresh')).toBe(false);
    expect(pending.conflicts).toHaveLength(1);
  });
  it('does not normalize ordinary readable strings', () => {
    const pending = confirmation(`${POD}settings/providers/deepseek.ttl`, { accountLabel: `${POD}Owned new row` });
    expect(pending.isConfirmed('fresh')).toBe(false);
    expect(pending.conflicts).toHaveLength(1);
  });
  it('keeps the original row and isolates resolver bindings for two Pods with identical ids', () => {
    const normalize = createProjectionNormalizer(context);
    const other = drizzle({ info: { isLoggedIn: true, webId: 'https://identity.example/alice/card#me' }, fetch }, {
      podUrl: 'https://local.example/bob/', schema: { credential: credentialResource, aiProvider: aiProviderResource }, autoConnect: false,
    });
    const normalizeOther = createProjectionNormalizer({ ...context, database: other });
    const intent = { id: 'fresh', provider: 'deepseek.ttl' };
    expect(normalizeOther(intent).provider).toBe('https://local.example/bob/settings/providers/deepseek.ttl');
    expect(normalize(intent).provider).toBe(`${POD}settings/providers/deepseek.ttl`);
    expect(intent.provider).toBe('deepseek.ttl');
    expect(hash(normalize(intent))).toBe(hash(normalize({ ...intent, provider: `${POD}settings/providers/deepseek.ttl` })));
  });
  it('retains exact comparison when no bound ORM resolver is available', () => {
    const normalize = createProjectionNormalizer({ ...context, database: {} as typeof database });
    expect(normalize({ provider: 'deepseek.ttl' })).toEqual({ provider: 'deepseek.ttl' });
  });
  it('refuses to guess a relationship when its declared linked table is missing', () => {
    const missing = drizzle({ info: { isLoggedIn: true, webId: 'https://identity.example/alice/card#me' }, fetch }, {
      podUrl: POD, schema: { credential: credentialResource }, autoConnect: false,
    });
    expect(() => createProjectionNormalizer({ ...context, database: missing })({ provider: 'deepseek.ttl' })).toThrow(/not found in schema/);
  });
  it('does not compare descriptor write-only secrets', () => {
    const local = { id: 'fresh', provider: 'deepseek.ttl', encryptedSecret: 'write-only-test-envelope' };
    const pending = createPendingWrites<Record<string, unknown>>();
    pending.register({ key: 'fresh', intent: local, localRow: local, beforeHash: undefined });
    reconcilePendingWrites(pending, new Map([['fresh', { id: 'fresh', provider: `${POD}settings/providers/deepseek.ttl` }]]), hash,
      writeOnlyFields(credentialDescriptor), context);
    expect(pending.isConfirmed('fresh')).toBe(true);
  });
  it('resolves a mapped URI array without changing foreign IRIs or fragments', () => {
    const models = drizzle({ info: { isLoggedIn: true, webId: 'https://identity.example/alice/card#me' }, fetch }, {
      podUrl: POD, schema: { aiProvider: aiProviderResource, aiModel: aiModelResource }, autoConnect: false,
    });
    const normalize = createProjectionNormalizer({ database: models, table: aiProviderResource, descriptor: aiProviderDescriptor });
    const foreign = 'https://foreign.example/settings/providers/deepseek.ttl#chat';
    const row = { id: 'deepseek', hasModel: ['deepseek.ttl#chat', foreign, 'deepseek.ttl#other'] };
    expect(normalize(row).hasModel).toEqual([`${POD}settings/providers/deepseek.ttl#chat`, foreign, `${POD}settings/providers/deepseek.ttl#other`]);
    expect(row.hasModel[0]).toBe('deepseek.ttl#chat');
  });
});
