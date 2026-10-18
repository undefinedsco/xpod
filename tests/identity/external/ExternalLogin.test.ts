import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { BaseAccountStore, MemoryResourceLocker, MemoryMapStorage, GreedyReadWriteLocker, WrappedExpiringReadWriteLocker,
  RepresentationMetadata, AbsolutePathInteractionRoute, RelativePathInteractionRoute, IdInteractionRoute,
  type JsonInteractionHandlerInput, type CookieStore } from '@solid/community-server';
import { DrizzleIndexedStorage } from '../../../src/identity/drizzle/DrizzleIndexedStorage';
import { closeAllIdentityConnections } from '../../../src/identity/drizzle/db';
import { LoginMethodGuardStorage } from '../../../src/identity/LoginMethodGuardStorage';
import { ExternalLoginService, EXTERNAL_LOGIN_TYPE } from '../../../src/identity/external/ExternalLoginService';
import { ExternalLoginHandler, ExternalLoginControls } from '../../../src/identity/external/ExternalLoginHandler';
import { ExternalLoginRepository } from '../../../src/identity/external/ExternalLoginRepository';
import { LogtoLoginProvider } from '../../../src/identity/external/ExternalLoginProvider';

mkdirSync('.test-data/external-login', { recursive: true });
const directory = mkdtempSync(path.resolve('.test-data/external-login/suite-'));
const baseUrl = 'https://id.example.test/';
const callback = `${baseUrl}.account/login/wechat/callback/`;
const proof = 'p'.repeat(64);
let service: ExternalLoginService;
let accounts: LoginMethodGuardStorage;
let store: BaseAccountStore;
let repository: ExternalLoginRepository;
let handler: ExternalLoginHandler;
let database: string;
let rowCount = 0;
const cookies: CookieStore = { generate: vi.fn(async () => `cookie-${++rowCount}`), delete: vi.fn(async () => true), get: vi.fn(), refresh: vi.fn() };
const route = new IdInteractionRoute(new RelativePathInteractionRoute(new AbsolutePathInteractionRoute(`${baseUrl}.account/`), 'login/'), 'providerId');
const locker = () => new WrappedExpiringReadWriteLocker(new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage()), 6000);
function input(json: unknown, suffix = '', accountId?: string): JsonInteractionHandlerInput {
  const target = { path: `${baseUrl}.account/login/wechat/${suffix}` };
  return { method: 'POST', target, metadata: new RepresentationMetadata(target), json, accountId };
}
const transaction = (intent: 'login' | 'register' | 'link', accountId?: string) => ({ intent, accountId, callback, returnTo: `${baseUrl}.account/`, remember: false });
async function finish(intent: 'login' | 'register' | 'link', accountId?: string) {
  const start = await service.begin('wechat', proof, transaction(intent, accountId));
  return service.finish('wechat', { state: start.state, proof, code: 'fixture-code', callback, accountId });
}

beforeEach(async () => {
  vi.clearAllMocks();
  database = `sqlite:${path.join(directory, `${++rowCount}.sqlite`)}`;
  accounts = new LoginMethodGuardStorage(new DrizzleIndexedStorage(database));
  store = new BaseAccountStore(accounts);
  await store.handle();
  service = new ExternalLoginService({ accountStorage: accounts, accountStore: store, locker: locker(), identityDbUrl: database, baseUrl });
  service.providers.set('wechat', { id: 'wechat', name: '微信', namespace: 'fixture-app', authorizationUrl: async (state, redirectUri) =>
    `https://open.weixin.qq.com/connect/qrconnect?${new URLSearchParams({ state, redirect_uri: redirectUri })}`,
  identity: vi.fn(async () => ({ subject: 'fixture-openid', unionId: 'fixture-unionid' })) });
  repository = new ExternalLoginRepository(database);
  handler = new ExternalLoginHandler(service, route, store, cookies);
});
afterAll(async () => { await closeAllIdentityConnections(); rmSync(directory, { recursive: true, force: true }); });

describe('External login with real SQLite and CSS account storage', () => {
  it('does not advertise an unconfigured provider and preserves password route routing', async () => {
    const disabled = new ExternalLoginService({ accountStorage: accounts, accountStore: store, locker: locker(), identityDbUrl: database, baseUrl });
    expect((await new ExternalLoginControls(disabled, route).handle(input({}))).json).toEqual({});
    await expect(handler.canHandle({ ...input({}), target: { path: `${baseUrl}.account/login/password/` } })).rejects.toMatchObject({ statusCode: 404 });
  });
  it('rejects partial deployment credentials', () => {
    expect(() => new ExternalLoginService({ accountStorage: accounts, accountStore: store, locker: locker(), identityDbUrl: database, baseUrl, wechatAppId: 'app' })).toThrow('both');
  });
  it('creates a passwordless account only on explicit registration, and logs it in again', async () => {
    await expect(finish('login')).rejects.toThrow('EXTERNAL_ACCOUNT_NOT_LINKED');
    const created = await finish('register');
    expect(created.remember).toBe(false);
    expect(await accounts.has('account', created.accountId)).toBe(true);
    expect((await finish('login')).accountId).toBe(created.accountId);
    const rows = await accounts.find(EXTERNAL_LOGIN_TYPE, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accountId: created.accountId, namespace: 'fixture-app', subject: 'fixture-openid' });
  });
  it('accepts one callback only, including concurrent retries', async () => {
    const start = await service.begin('wechat', proof, transaction('register'));
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => service.finish('wechat', { state: start.state, proof, code: 'code', callback })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await accounts.find('account', {})).toHaveLength(1);
  });
  it('rejects the wrong browser proof without consuming the rightful transaction', async () => {
    const start = await service.begin('wechat', proof, transaction('register'));
    await expect(service.finish('wechat', { state: start.state, proof: 'q'.repeat(64), code: 'code', callback })).rejects.toThrow('INVALID');
    expect((await service.finish('wechat', { state: start.state, proof, code: 'code', callback })).accountId).toBeTruthy();
  });
  it('rejects expired state before calling the provider', async () => {
    const now = Date.now();
    const start = await service.begin('wechat', proof, transaction('register'));
    vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000);
    try { await expect(service.finish('wechat', { state: start.state, proof, code: 'code', callback })).rejects.toThrow('EXPIRED'); }
    finally { vi.restoreAllMocks(); }
    expect(service.provider('wechat').identity).not.toHaveBeenCalled();
  });
  it('rejects a changed OIDC interaction or account actor', async () => {
    const start = await service.begin('wechat', proof, { ...transaction('register'), interaction: 'one' });
    await expect(service.finish('wechat', { state: start.state, proof, code: 'code', callback, interaction: 'two' })).rejects.toThrow('CONTEXT_CHANGED');
    const actor = await store.create();
    const second = await service.begin('wechat', proof, transaction('register'));
    await expect(service.finish('wechat', { state: second.state, proof, code: 'code', callback, accountId: actor })).rejects.toThrow('CONTEXT_CHANGED');
  });
  it('links only the current account and rejects a binding collision', async () => {
    const first = await store.create();
    expect(await finish('link', first)).toMatchObject({ accountId: first, remember: undefined });
    const second = await store.create();
    await expect(finish('link', second)).rejects.toThrow('ALREADY_BOUND');
    expect((await finish('login')).accountId).toBe(first);
    await expect(service.begin('wechat', proof, transaction('link'))).rejects.toThrow('ACCOUNT_LOGIN_REQUIRED');
  });
  it('keeps the last login method guard and allows unlinking with a remaining password', async () => {
    const { accountId } = await finish('register');
    await expect(service.unlink('wechat', accountId)).rejects.toThrow('at least 1');
    await accounts.defineType('password-test', { accountId: 'id:account' }, true);
    await accounts.create('password-test', { accountId });
    await service.unlink('wechat', accountId);
    expect(await accounts.find(EXTERNAL_LOGIN_TYPE, { accountId })).toHaveLength(0);
    await expect(finish('login')).rejects.toThrow('NOT_LINKED');
  });
  it('reserves the subject atomically across independent workers', async () => {
    const repository2 = new ExternalLoginRepository(database);
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => (index % 2 ? repository : repository2).reserve('same-subject')));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  });
  it('uses the normal CSS cookie, remember setting and interaction completion', async () => {
    const start = await handler.handleSafe(input({ intent: 'register', proof, remember: true }));
    const persist = vi.fn(async () => undefined);
    const interaction = { uid: 'flow', returnTo: `${baseUrl}.oidc/auth/flow`, lastSubmission: {}, persist };
    // Start and finish must both carry the original CSS interaction.
    const scoped = await handler.handleSafe({ ...input({ intent: 'register', proof, remember: true }), oidcInteraction: interaction as any });
    expect(scoped.json.callback).toBe(`${baseUrl}.account/interaction/flow/login/wechat/callback/`);
    expect(new URL(String(scoped.json.authorizationUrl)).searchParams.get('redirect_uri')).toBe(callback);
    const result = await handler.handleSafe({ ...input({ state: scoped.json.state, proof, code: 'code' }, 'callback/'), oidcInteraction: interaction as any });
    expect(result.json.authorization).toMatch(/^cookie-/u);
    expect(result.json.location).toBe(interaction.returnTo);
    expect(result.json).not.toHaveProperty('accountId');
    expect(persist).toHaveBeenCalledTimes(1);
    expect(start.json).not.toHaveProperty('authorization');
    const rows = await accounts.find('account', {});
    expect(rows[0].rememberLogin).toBe(true);
  });
  it('rejects external return targets, unexpected intent and GET exchange', async () => {
    await expect(handler.handleSafe(input({ intent: 'register', proof, returnTo: 'https://evil.test/' }))).rejects.toThrow('INVALID_RETURN_TO');
    await expect(handler.handleSafe(input({ intent: 'other', proof }))).rejects.toThrow('INVALID_LOGIN_INTENT');
    await handler.handleSafe({ ...input({}, 'callback/'), method: 'GET' });
    expect(service.provider('wechat').identity).not.toHaveBeenCalled();
  });
  it('does not expose upstream secrets in connector errors, or change identity when unionid appears', async () => {
    const getUserInfo = vi.fn(async () => ({ rawData: { openid: 'stable', unionid: 'other' } }));
    const adapter = new LogtoLoginProvider('wechat', '微信', 'app', async () => ({ getAuthorizationUri: async () => '', getUserInfo }), 'openid', 'unionid');
    expect(await adapter.identity('code')).toEqual({ subject: 'stable', unionId: 'other' });
    getUserInfo.mockRejectedValueOnce(new Error('secret=DO_NOT_EXPOSE'));
    await expect(adapter.identity('code')).rejects.toThrow('EXTERNAL_AUTHORIZATION_FAILED');
    await expect(adapter.identity('code')).resolves.toHaveProperty('subject', 'stable');
  });
});
