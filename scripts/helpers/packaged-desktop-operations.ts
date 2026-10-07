import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { credentialResource } from '@undefineds.co/models';
import type { Page, Request, Response } from '@playwright/test';
import type { AiConnectionsProvider, CreateApiKeyCredentialInput } from '@undefineds.co/ai-connections/client';
import type { MountedPodPermissionPhase } from './packaged-desktop-permissions';

/** Closed boundary names are the only operation detail published by CI. */
export type PackagedOperationCondition = 'provider-identity' | 'provider-collection'
  | 'provider-create' | 'provider-confirm' | 'provider-publication' | 'provider-cleanup'
  | 'key-dialog' | 'key-cleanup' | 'held-invocation' | 'first-chat';

export class PackagedOperationError extends Error {
  override readonly cause: unknown;
  constructor(readonly condition: PackagedOperationCondition, cause: unknown) {
    super('Packaged operation rejected at ' + condition);
    this.name = 'PackagedOperationError';
    this.cause = cause;
  }
}

/** Attribute the real operation, retaining its untranslated rejection privately. */
export async function attributePackagedOperation<T>(condition: PackagedOperationCondition,
  action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) {
    if (error instanceof PackagedOperationError) throw error;
    if (error instanceof AggregateError && error.errors[0] instanceof PackagedOperationError) throw error;
    throw new PackagedOperationError(condition, error);
  }
}

export function accountCreationResponseSucceeded(status: number, authorization?: string): boolean {
  return status >= 200 && status < 300 && authorization?.startsWith('CSS-Account-Token ') === true;
}

/** A missing Pod row does not prove the Account compensation succeeded. */
export function assertAccountCredentialsRestored(baseline: string[], current: Array<{ clientId: string }>): void {
  if (current.some(record => !baseline.includes(record.clientId))) throw new Error('New Account credential remains after key cleanup');
}

export function assertNewAccountCredential(baseline: string[], current: Array<{ clientId: string }>, clientId: string): void {
  const added = current.filter(record => !baseline.includes(record.clientId));
  if (baseline.includes(clientId) || added.length !== 1 || added[0].clientId !== clientId) {
    throw new Error('Key record does not bind the newly issued Account credential');
  }
}

export function assertMountedModelBinding(input: { provider: string; credentialId: string; model: string; webId: string }, result: {
  credential?: { id: string; provider?: string }; credentialCount: number; providerId: string; webId: string;
  discovery: { provider: string; credential: string; models: Array<{ id: string }> };
  models: Array<{ id: string; provider: string; credentialId?: string; availability?: string }>;
}): void {
  const { credential, discovery, models } = result;
  if (result.credentialCount !== 1 || credential?.id !== input.credentialId || result.providerId !== input.provider
    || (credential.provider !== undefined && credential.provider !== input.provider)
    || result.webId !== input.webId || discovery.provider !== input.provider || discovery.credential !== input.credentialId
    || !discovery.models.some(model => model.id === input.model) || models.length !== 1
    || models[0].id !== input.model || models[0].provider !== input.provider || models[0].availability === 'unavailable'
    || (models[0].credentialId !== undefined && models[0].credentialId !== input.credentialId)) {
    throw new Error('Actual credential/discovery/publication binding differs from the selection');
  }
}

async function until<T>(probe: () => Promise<T | undefined>, label: string,
  condition: PackagedOperationCondition): Promise<T> {
  return attributePackagedOperation(condition, async () => {
    const deadline = Date.now() + 30_000;
    do {
      const result = await probe();
      if (result !== undefined) return result;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new Error(label);
  });
}

async function mountedCredentialConfirmed(phase: MountedPodPermissionPhase, resourceId: string,
  present: boolean): Promise<boolean> {
  const state = await phase.handle.evaluate(({ controller }) => {
    const collection = controller.credentialsCollection;
    if (!collection || collection.conflicts.length) throw new Error('Credential confirmation conflicted');
    return { ready: collection.isReady(), pending: collection.pendingKeys.size,
      ids: controller.credentialRows?.map(row => String(row.id)) };
  });
  // Collection rows carry descriptor keys; provider summaries carry resource ids.
  // Models owns this mapping, and runs here rather than inside the serialized callback.
  const expected = credentialResource.buildId({ id: resourceId });
  return state.ready && state.ids !== undefined && state.pending === 0
    && state.ids.some(id => credentialResource.buildId({ id }) === expected) === present;
}

/** Require collection adoption before writing, then independently observe its
 * readback/confirmation. Polling reads never retries a credential mutation.
 */
export async function createConfirmedMountedProvider(phase: MountedPodPermissionPhase, input: {
  provider: AiConnectionsProvider; credential: CreateApiKeyCredentialInput; model?: string; expectedModels?: string[];
}): Promise<{ credentialId: string; model: string; quotaObserved: true; remove(): Promise<true> }> {
  const { handle } = phase;
  const boundWebId = await attributePackagedOperation('provider-identity', () => handle.evaluate(({ host, controller }) => {
    const session = host.solid.session.getSnapshot();
    if (session.status !== 'authenticated' || host.solid.pod?.status !== 'ready'
      || session.webId !== host.solid.pod.current.webId || controller.client?.webId !== session.webId) {
      throw new Error('Mounted provider identity is unavailable');
    }
    return session.webId;
  }));
  await until(async () => handle.evaluate(({ controller }) =>
    controller.credentialsCollection?.isReady() && controller.credentialsCollection.pendingKeys.size === 0 ? true : undefined),
  'Mounted credential collection did not become ready', 'provider-collection');
  const created = await attributePackagedOperation('provider-create', () => handle.evaluate(({ controller }, input) => {
    if (!controller.client) throw new Error('Missing mounted AI client');
    return controller.client.createApiKeyCredential(input.provider, input.credential);
  }, input));
  const remove = async (): Promise<true> => attributePackagedOperation<true>('provider-cleanup', async () => {
    await handle.evaluate(({ controller }, input) => controller.client!.deleteProviderCredential(input.provider, input.id),
      { provider: input.provider, id: created.id });
    await until(async () => await mountedCredentialConfirmed(phase, created.id, false) ? true : undefined,
      'Credential cleanup was not independently confirmed', 'provider-cleanup');
    const absent = await handle.evaluate(async ({ controller }, input) => {
      const rows = await controller.client!.listProviders();
      return !rows.find(row => row.id === input.provider)?.credentials.some(row => row.id === input.id);
    }, { provider: input.provider, id: created.id });
    if (!absent) throw new Error('Removed credential persisted in provider readback');
    return true;
  });
  try {
    await until(async () => await mountedCredentialConfirmed(phase, created.id, true) ? true : undefined,
      'Credential mutation was not confirmed', 'provider-confirm');
    const result = await attributePackagedOperation('provider-publication', () => handle.evaluate(async ({ controller }, input) => {
      const client = controller.client!;
      const providers = await client.listProviders();
      const provider = providers.find(row => row.id === input.provider);
      const credential = provider?.credentials.find(row => row.id === input.id);
      if (!credential) throw new Error('Credential is absent from independent Pod readback');
      const discovery = await client.discoverModels(input.provider, { credentialId: input.id });
      const selectedModel = input.model ?? input.expectedModels?.find(id => discovery.models.some(row => row.id === id));
      if (!selectedModel || !discovery.models.some(row => row.id === selectedModel)) throw new Error('Requested model was not actually discovered');
      if (!client.saveModelSelection || !client.listGatewayModels) throw new Error('Missing declared model publication capability');
      await client.saveModelSelection(input.provider, [{ id: selectedModel }], input.id);
      const models = await client.listGatewayModels();
      if (models.length !== 1 || !models[0].id || models[0].availability === 'unavailable') throw new Error('Fresh Gateway model projection is inconsistent');
      const quota = await client.quota(input.provider, true, { credentialId: input.id });
      if (quota.status !== 'available') throw new Error('Provider quota was not actually available');
      return { credential, credentialCount: provider!.credentials.length, providerId: provider!.id, discovery, models, selectedModel, webId: client.webId };
    }, { provider: input.provider, id: created.id, model: input.model, expectedModels: input.expectedModels }));
    await attributePackagedOperation('provider-publication', async () =>
      assertMountedModelBinding({ provider: input.provider, credentialId: created.id, model: result.selectedModel, webId: boundWebId }, result));
    return { credentialId: created.id, model: result.models[0].id, quotaObserved: true, remove };
  } catch (error) {
    try { await remove(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Provider phase and cleanup failed'); }
    throw error;
  }
}

/** Validate actual files produced by configuration apply, not merely fixture env.
 * It returns the newly issued wrapper only to this private runner process.
 */
export async function readOwnedPiConfiguration(home: string, gateway: string): Promise<string> {
  const directory = await realpath(home);
  const read = async (name: string): Promise<string> => {
    const file = path.join(directory, '.pi', 'agent', name);
    if (!(await realpath(file)).startsWith(directory + path.sep) || !(await lstat(file)).isFile()) {
      throw new Error('Configuration apply escaped the fixture home');
    }
    return readFile(file, 'utf8');
  };
  const models = JSON.parse(await read('models.json')) as { providers?: { xpod?: { baseUrl?: unknown; apiKey?: unknown } } };
  const settings = JSON.parse(await read('settings.json')) as { defaultProvider?: unknown };
  const provider = models.providers?.xpod;
  if (provider?.baseUrl !== new URL('v1', gateway).href || typeof provider.apiKey !== 'string' || !provider.apiKey
    || settings.defaultProvider !== 'xpod') throw new Error('Applied configuration differs from the own Gateway');
  return provider.apiKey;
}

/** Real key dialog → Account credential → Pod record → actual fixture-only files.
 * Never replaces clipboard, fetch, forms or the applet's credential capability.
 */
export async function createMountedKeyInUi(page: Page, phase: MountedPodPermissionPhase, input: {
  name: string; configurationHome: string; gateway: string; accountCredentialControl: string;
}): Promise<{ key: string; id: string; accountActor: true; remove(): Promise<true> }> {
  const control = new URL(input.accountCredentialControl);
  let accountCreationSucceeded = false;
  const baseline = await phase.handle.evaluate(async ({ host }) => {
    const capability = host.capabilities.aiClientCredentials;
    if (!capability) throw new Error('Missing original Account actor');
    return (await capability.list()).map(record => record.clientId);
  });
  const verifyAccountCleanup = async (): Promise<void> => {
    const current = await phase.handle.evaluate(async ({ host }) => {
      if (!host.capabilities.aiClientCredentials) throw new Error('Missing original Account actor');
      return host.capabilities.aiClientCredentials.list();
    });
    assertAccountCredentialsRestored(baseline, current);
  };
  const response = (response: Response): void => {
    if (response.url() === control.href && response.request().method() === 'POST') {
      accountCreationSucceeded ||= accountCreationResponseSucceeded(response.status(), response.request().headers().authorization);
    }
  };
  page.on('response', response);
  try {
    await phase.handle.evaluate(({ controller }) => controller.selectSection('keys'));
    await page.getByRole('button', { name: '新建 Xpod 密钥', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Xpod 密钥 名称', exact: true }).fill(input.name);
    await dialog.getByRole('combobox', { name: 'Xpod 密钥 用途', exact: true }).selectOption('pi');
    await dialog.getByRole('button', { name: '创建 Xpod 密钥', exact: true }).click();
    await dialog.getByRole('heading', { name: 'Xpod 密钥 已签发', exact: true }).waitFor();
    if (!accountCreationSucceeded) throw new Error('Key dialog did not use the current Account actor');
    const records = await phase.handle.evaluate(({ controller }) => controller.client!.listGatewayKeys());
    const matching = records.filter(record => record.name === input.name);
    const owner = await phase.handle.evaluate(({ controller }) => controller.client!.webId);
    if (matching.length !== 1 || matching[0].owner !== owner || matching[0].kind !== 'client-credentials' || !matching[0].clientCredentialId) throw new Error('Key dialog record readback mismatch');
    const accountRecords = await phase.handle.evaluate(async ({ host }) => {
      if (!host.capabilities.aiClientCredentials) throw new Error('Missing original Account actor');
      return host.capabilities.aiClientCredentials.list();
    });
    assertNewAccountCredential(baseline, accountRecords, matching[0].clientCredentialId);
    const id = matching[0].id;
    await dialog.getByRole('button', { name: '写入 Pi', exact: true }).click();
    await dialog.getByText('已应用到 Pi', { exact: true }).waitFor();
    const key = await readOwnedPiConfiguration(input.configurationHome, input.gateway);
    await dialog.getByRole('button', { name: '完成', exact: true }).click();
    const remove = async (): Promise<true> => {
      await phase.handle.evaluate(({ controller }) => controller.selectSection('keys'));
      await page.getByRole('button', { name: `销毁 ${input.name}`, exact: true }).click();
      await page.getByRole('button', { name: `确认删除 ${input.name}`, exact: true }).click();
      await until(async () => phase.handle.evaluate(async ({ controller }, id) => {
        const records = await controller.client!.listGatewayKeys();
        return !records.some(record => record.id === id && !record.revokedAt) ? true : undefined;
      }, id), 'UI key revoke did not remove the Pod record', 'key-cleanup');
      const accountAbsent = await phase.handle.evaluate(async ({ host }, clientId) => {
        const capability = host.capabilities.aiClientCredentials;
        if (!capability) throw new Error('Missing original Account actor');
        return !(await capability.list()).some(record => record.clientId === clientId);
      }, matching[0].clientCredentialId!);
      if (!accountAbsent) throw new Error('UI key revoke left the Account credential active');
      await verifyAccountCleanup();
      return true;
    };
    return { key, id, accountActor: true, remove };
  } catch (error) {
    // Dialog/configuration failure may happen after Account issuance. Reuse the
    // same guarded product client to revoke this uniquely named owned record.
    try {
      await phase.handle.evaluate(async ({ controller }, name) => {
        const client = controller.client!;
        const records = (await client.listGatewayKeys()).filter(record => record.name === name);
        if (records.length > 1 || records.some(record => record.owner !== client.webId)) throw new Error('Owned key cleanup is ambiguous');
        if (records.length === 1) await client.deleteGatewayKey(records[0].id);
      }, input.name);
      await verifyAccountCleanup();
    } catch (cleanup) { throw new AggregateError([error, cleanup], 'Key dialog and cleanup failed'); }
    throw error;
  } finally { page.off('response', response); }
}

/** Send once in the real renderer using the wrapper the user UI just issued.
 * Body equality and the observed network count are separate mandatory facts.
 */
export async function acceptMountedFirstChat(page: Page, input: {
  gateway: string; podUrl: string; key: string; model: string; marker: string;
}): Promise<{ status: 200; bodyMatches: true; dispatches: 1 }> {
  const endpoint = new URL('v1/chat/completions', input.gateway).href;
  let dispatches = 0;
  const observe = (request: Request): void => { if (request.url() === endpoint && request.method() === 'POST') dispatches++; };
  page.on('request', observe);
  try {
    const result = await page.evaluate(async input => {
      if (new URL(input.endpoint).origin !== window.location.origin) throw new Error('Chat is outside the owned Gateway');
      const response = await fetch(input.endpoint, { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${input.key}`, 'X-Xpod-Pod-Url': input.podUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: input.model, messages: [{ role: 'user', content: `Reply exactly ${input.marker}` }], temperature: 0, max_tokens: 32 }),
        signal: AbortSignal.timeout(90_000) });
      const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      return { status: response.status, bodyMatches: body.choices?.[0]?.message?.content === input.marker };
    }, { ...input, endpoint });
    if (result.status !== 200 || result.bodyMatches !== true || dispatches !== 1) throw new Error('Actual Chat status, body or first-dispatch count failed');
    return { status: 200, bodyMatches: true, dispatches: 1 };
  } finally { page.off('request', observe); }
}

/** Reuse the descriptor's same held invocation twice on its authoritative Pod.
 * This exercises the server scope and session-independent capability without
 * issuing another credential or replaying any mutation.
 */
export async function acceptHeldPodInvocation(page: Page, input: {
  gateway: string; podUrl: string; invocation: string; model: string;
}): Promise<true> {
  const statuses = await page.evaluate(async input => {
    const endpoint = new URL('v1/models', input.gateway);
    if (endpoint.origin !== window.location.origin) throw new Error('Held invocation is outside the own Gateway');
    const observed: boolean[] = [];
    for (let index = 0; index < 2; index++) {
      const response = await fetch(endpoint.href, { redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${input.invocation}`, 'X-Xpod-Pod-Url': input.podUrl } });
      const value = await response.json() as { data?: Array<{ id?: string }> };
      observed.push(response.status === 200 && value.data?.length === 1 && value.data[0].id === input.model);
    }
    return observed;
  }, input);
  if (statuses.length !== 2 || statuses.some(value => value !== true)) throw new Error('Same-Pod held invocation reuse failed');
  return true;
}
