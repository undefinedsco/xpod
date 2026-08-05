import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuthContext } from '../../src/api/auth/AuthContext';
import { HostedPodDataAccess } from '../../src/api/ai-gateway/pod/HostedPodDataAccess';
import { PodModelSelectionRepository } from '../../src/api/ai-gateway/models/PodModelSelectionRepository';
import { XpodTestStack } from '../helpers/XpodTestStack';
import { setupAccount, type AccountSetup } from './helpers/solidAccount';

const RUN_INTEGRATION_TESTS = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
const suite = RUN_INTEGRATION_TESTS ? describe : describe.skip;

function auth(account: AccountSetup): AuthContext {
  return {
    type: 'solid',
    webId: account.webId,
    scopes: [ 'ai:credentials:read', 'ai:credentials:write' ],
  };
}

async function readDocument(stack: XpodTestStack, url: string): Promise<string> {
  const response = await stack.runtimeFetch(url, {
    headers: { Accept: 'text/turtle' },
  });
  if (response.status === 404) {
    return '';
  }
  expect(response.ok, `${url} returned ${response.status}`).toBe(true);
  return response.text();
}

suite('AI Gateway Pod model selection isolation integration', () => {
  const runtimeRoot = path.resolve('.test-data/ai-gateway-pod-isolation', randomUUID());
  let stack: XpodTestStack;
  let alice: AccountSetup;
  let bob: AccountSetup;
  let repository: PodModelSelectionRepository;

  beforeAll(async() => {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
    stack = new XpodTestStack();
    await stack.start('local', {
      transport: 'port',
      runtimeRoot,
      logLevel: 'error',
    });

    const baseUrl = stack.baseUrl.replace(/\/$/u, '');
    const aliceAccount = await setupAccount(baseUrl, `ai-alice-${randomUUID().slice(0, 8)}`);
    const bobAccount = await setupAccount(baseUrl, `ai-bob-${randomUUID().slice(0, 8)}`);
    if (!aliceAccount || !bobAccount) {
      throw new Error('Unable to provision accounts for AI Gateway isolation integration.');
    }
    alice = aliceAccount;
    bob = bobAccount;

    const internalPodAccess = new HostedPodDataAccess({
      cssBaseUrl: stack.baseUrl,
      gatewayAdminProxyAuthSecret: stack.testGatewayAdminProxyAuthSecret,
      fetch: async(input, init) => stack.runtimeFetch(new Request(input, init)),
    });
    repository = new PodModelSelectionRepository({ internalPodAccess });
  }, 180_000);

  afterAll(async() => {
    await stack?.stop();
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  });

  it('persists Alice selections across repository reloads while Bob remains empty', async() => {
    const initial = await repository.listSelection({
      webId: alice.webId,
      provider: 'openai',
      auth: auth(alice),
    });
    expect(initial.models).toEqual([]);

    await repository.replaceSelection({
      webId: alice.webId,
      provider: 'openai',
      models: [{ id: 'gpt-5', modelType: 'chat', displayName: 'GPT-5' }],
      expectedVersion: initial.version,
      auth: auth(alice),
    });

    // Constructing a fresh repository exercises the actual Pod reload path;
    // no in-memory fixture or shared test map is involved.
    const reloaded = new PodModelSelectionRepository({
      internalPodAccess: new HostedPodDataAccess({
        cssBaseUrl: stack.baseUrl,
        gatewayAdminProxyAuthSecret: stack.testGatewayAdminProxyAuthSecret,
        fetch: async(input, init) => stack.runtimeFetch(new Request(input, init)),
      }),
    });
    await expect(reloaded.listSelection({
      webId: alice.webId,
      provider: 'openai',
      auth: auth(alice),
    })).resolves.toMatchObject({
      provider: 'openai',
      models: [ expect.objectContaining({ id: 'openai.ttl#gpt-5', status: 'active' }) ],
    });
    await expect(reloaded.listSelection({
      webId: bob.webId,
      provider: 'openai',
      auth: auth(bob),
    })).resolves.toMatchObject({ provider: 'openai', models: [] });

    const aliceDocument = await readDocument(stack, new URL('settings/providers/openai.ttl', alice.podUrl).href);
    const bobDocument = await readDocument(stack, new URL('settings/providers/openai.ttl', bob.podUrl).href);
    expect(aliceDocument).toContain('gpt-5');
    expect(bobDocument).not.toContain('gpt-5');
  }, 180_000);
});
