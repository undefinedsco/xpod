import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createOwnerCredentialFetch, prepareManagedLocalAcceptancePod } from '../../scripts/accept-live-gateway-login-chat';
import { ProvisionCodeCodec } from '../../src/provision/ProvisionCodeCodec';
import { createProvisionReceipt } from '../../src/provision/ProvisionReceiptCodec';
import ts from 'typescript';

describe('real running Xpod login-to-chat acceptance runner', () => {
  it('type-checks the real canary against the current client and Pod store contracts', () => {
    const entry = path.resolve('scripts/accept-live-gateway-login-chat.ts');
    const program = ts.createProgram([entry], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      types: ['node'],
      noEmit: true,
    });
    expect(program.getSourceFile(entry)).toBeDefined();
    // This is the entry's contract gate; unrelated imported projects retain
    // their own build/type gates. Do not execute the live acceptance entry.
    const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) =>
      diagnostic.file && path.resolve(diagnostic.file.fileName) === entry);
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });

  it('uses distinct short Pod names when modes run concurrently against the same Cloud', async () => {
    const script = await readFile(path.resolve('scripts/accept-live-gateway-login-chat.ts'), 'utf8');
    expect(script).toContain('normalizeAcceptanceName(`a-${MODE}-${randomUUID().slice(0, 8)}`)');
    expect(script).not.toContain('normalizeAcceptanceName(`accept-${ACCEPT_ID}`)');
  });

  it('registers and verifies a CSS client credential as an Xpod Gateway API Key', async () => {
    const script = await readFile(path.resolve('scripts/accept-live-gateway-login-chat.ts'), 'utf8');

    expect(script).toContain('await client.createGatewayKey');
    expect(script).toContain('await client.listGatewayKeys');
    expect(script).not.toContain('revealGatewayKey');
    expect(script).toContain('await client.deleteGatewayKey');
    expect(script).toContain('revocation is verified during cleanup');
    expect(script).not.toContain('await client.updateGatewayKey');
    expect(script).not.toContain('function codingClientKey');
    expect(script).not.toContain('Bearer sk- wrapper accepted');
    expect(script).not.toContain('Buffer.from(`${clientId}:${clientSecret}`)');
  });

  it('uses the product Cloud account provisioning path for a Local-managed Pod', async () => {
    const script = await readFile(path.resolve('scripts/accept-live-gateway-login-chat.ts'), 'utf8');

    expect(script).toContain('createCloudAccountPassword');
    expect(script).toContain('prepareLocalProvisionedPod');
    expect(script).toContain('createCloudManagedLocalPod');
    expect(script).toContain('POST Local /provision/pods');
    expect(script).toContain('cloudBaseUrl: options.baseUrl');
    expect(script).toContain('new ProvisionCodeCodec(options.cloudBaseUrl)');
    expect(script).toContain('podName: options.username');
    expect(script).toContain('provisionCode: options.provisionCode');
    expect(script).toContain('provisionReceipt: options.provisionReceipt');
    expect(script).not.toContain('receipt: body.receipt');
    expect(script).toContain('controls.account.pod');
    expect(script).toContain('controls.account.clientCredentials');
    expect(script).not.toContain('setupAccount(');
    expect(script).not.toContain('provisionLocalPod(');
    expect(script).not.toContain('Authorization: `Bearer ${serviceAccessToken}`');
  });

  it('records provisioning and Solid login failures in the identity acceptance layer', async () => {
    const script = await readFile(path.resolve('scripts/accept-live-gateway-login-chat.ts'), 'utf8');

    expect(script).toContain("fail('identity', redact(message))");
    expect(script.indexOf("layer('identity', true")).toBeGreaterThan(
      script.indexOf("phase: 'client-credentials-login-complete'"),
    );
  });

  it('pins live acceptance to the selected Xpod root and RC Pod authority', async () => {
    const script = await readFile(path.resolve('scripts/accept-live-gateway-login-chat.ts'), 'utf8');

    expect(script).toContain('process.env.XPOD_BASE_URL');
    expect(script).not.toContain('XPOD_LIVE_GATEWAY_URL');
    expect(script).not.toContain('XPOD_LIVE_BASE_URL');
    expect(script).toContain('Local route points at');
    expect(script).toContain('Canonical Pod route must use HTTPS');
    expect(script).toContain('Canonical Pod route is not a Cloud-assigned protocol address');
    expect(script).not.toContain("canonicalPodUrl.origin === new URL(CLOUD_IDP).origin");
    expect(script).toContain('does not match acceptance Cloud');
  });

  it('fails closed when the configured provider file is invalid', async () => {
    const script = await readFile(path.resolve('scripts/accept-live-gateway-login-chat.ts'), 'utf8');

    expect(script).toContain('fileState.present && !fileState.spec');
    expect(script).toContain("fail('aiConnections', `Provider key file is present but invalid:");
  });

  it('does not turn an unsuccessful Provider import into configuration acceptance via existing models', async () => {
    const script = await readFile(path.resolve('scripts/accept-live-gateway-login-chat.ts'), 'utf8');

    expect(script).not.toContain('using existing selected models');
    expect(script).toContain("layer('chat', false, 'Skipped: no verified provider credential')");
  });

  it('marks a credential healthy only after successful live model discovery', async () => {
    const script = await readFile(path.resolve('scripts/accept-live-gateway-login-chat.ts'), 'utf8');
    const discovery = script.indexOf('const discovery = await client.discoverModels(provider.id');
    const healthy = script.indexOf("await podStore.markCredentialHealth(provider.id, credential.id, 'healthy'");
    const projection = script.lastIndexOf('await projectModelsAndChat(gatewayKey, selectedIds)');

    expect(discovery).toBeGreaterThan(-1);
    expect(healthy).toBeGreaterThan(discovery);
    expect(projection).toBeGreaterThan(healthy);
  });

  it('keeps separate evidence for cloud, local, and standalone runs', async () => {
    const script = await readFile(path.resolve('scripts/accept-live-gateway-login-chat.ts'), 'utf8');

    expect(script).toContain('process.env.XPOD_LIVE_MODE');
    expect(script).toContain('live-gateway-login-chat-${MODE}.json');
    expect(script).toContain("MODE === 'local'");
    expect(script).toContain('createHostedPod');
    expect(script).toContain('mode: MODE');
  });

  it('never accepts an unrelated Pod as proof of a Local binding', async () => {
    const script = await readFile(path.resolve('scripts/accept-live-gateway-login-chat.ts'), 'utf8');

    expect(script).not.toContain('?? candidates[0]');
  });

  it('checks both actual probe requests instead of any earlier Gateway request', async () => {
    const script = await readFile(path.resolve('scripts/accept-live-gateway-login-chat.ts'), 'utf8');
    expect(script).toContain('expectedProbeTarget');
    expect(script).toContain("['PUT', 'GET']");
    expect(script).not.toContain('localSolidTargets.find((target) => target.startsWith(GATEWAY))');
  });

  it('is the package live-acceptance entry point rather than an isolated test stack', async () => {
    const manifest = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(manifest.scripts?.['ai-connections:accept:live']).toBe(
      'bun run build:packages && bun scripts/accept-live-gateway-login-chat.ts',
    );
    expect(manifest.scripts?.['ai-connections:accept:isolated']).toBe(
      'bun scripts/accept-live-ai-connections.ts',
    );
  });
});

/**
 * The live acceptance's owner-credential fetch.
 *
 * It exists because the API holds no owner key (decision 7), so the caller has to bring one. What it
 * must NOT do is bypass the transport: a managed local node addresses the API and its Pod through
 * canonical URLs that only the runtime's route transport resolves, and a bare `fetch` sends those to
 * the node's public entry - which is how the 0.4.16 candidate turned a registration into
 * "The socket connection was closed unexpectedly".
 */
describe('live gateway acceptance credential fetch', () => {
  it('sends the caller credential through the runtime transport', async () => {
    const transport = vi.fn(async () => new Response('{}', { status: 201 }));
    const fetchWithCredential = createOwnerCredentialFetch(
      { clientId: 'client-id', clientSecret: 'client-secret' },
      transport as unknown as typeof fetch,
    );

    const response = await fetchWithCredential('https://node.example/api/ai/gateway/keys', {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: JSON.stringify({ name: 'probe' }),
    });

    expect(response.status).toBe(201);
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://node.example/api/ai/gateway/keys');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(
      `Bearer sk-${Buffer.from('client-id:client-secret', 'utf8').toString('base64')}`,
    );
    expect(headers.get('accept')).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ name: 'probe' }));
  });

  it('never falls back to the global fetch when a transport is given', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    try {
      const transport = vi.fn(async () => new Response('{}', { status: 200 }));
      const fetchWithCredential = createOwnerCredentialFetch(
        { clientId: 'client-id', clientSecret: 'client-secret' },
        transport as unknown as typeof fetch,
      );

      await fetchWithCredential('https://node.example/api/ai/gateway/keys');

      expect(transport).toHaveBeenCalledTimes(1);
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      globalFetch.mockRestore();
    }
  });
});

/** Only in-memory protocol responses; no live account, provider or external route. */
describe('managed Local live acceptance provisioning protocol', () => {
  const baseUrl = 'https://id.example/';
  const localBaseUrl = 'http://127.0.0.1:3000/';
  const canonicalBaseUrl = 'https://node.nodes.example/';
  const webId = `${baseUrl}identity/profile/card#me`;
  const podUrl = `${canonicalBaseUrl}alice/`;
  const authorization = 'fixture-account-token';
  const controls = { account: {
    profile: `${baseUrl}.account/account/account-1/profile/`,
    pod: `${baseUrl}.account/account/account-1/pod/`,
    bindings: `${baseUrl}.account/account/account-1/bindings/`,
  } };
  const provisionCode = new ProvisionCodeCodec(baseUrl).encode({
    spUrl: canonicalBaseUrl, serviceAccessToken: 'fixture-local-callback',
    serviceAccessTokenExp: Math.floor(Date.now() / 1000) + 600,
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  const receipt = createProvisionReceipt({
    secret: 'fixture-private-receipt-key', podName: 'alice', webId, podUrl,
  });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' },
  });
  const options = { baseUrl, localBaseUrl, canonicalBaseUrl, authorization, controls,
    username: 'alice', provisionCode };

  function protocol(responses: unknown[] = [
    { webId, webIdLink: 'link-1' }, { webId, podUrl, provisionReceipt: receipt },
    { webId, pod: podUrl, podResource: `${controls.account.pod}pod-1/`,
      webIdResource: `${baseUrl}.account/account/account-1/webid/link-1/` },
    { bindings: [{ webId, storageUrl: podUrl }] },
  ]) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: input instanceof Request ? input.url : String(input), init });
      const result = responses.shift();
      if (result === undefined) throw new Error('Unexpected extra provisioning request');
      return result instanceof Response ? result : json(result);
    };
    return { calls, fetchImpl };
  }

  it('prepares the Cloud identity before Local storage, forwards the original receipt, and verifies the Account pair', async () => {
    const { calls, fetchImpl } = protocol();
    await expect(prepareManagedLocalAcceptancePod({ ...options, fetchImpl }))
      .resolves.toEqual({ webId, storageUrl: podUrl });
    expect(calls.map(({ url }) => url)).toEqual([
      controls.account.profile, `${localBaseUrl}provision/pods`, controls.account.pod, controls.account.bindings,
    ]);
    expect(calls.map(({ init }) => init?.method ?? 'GET')).toEqual(['POST', 'POST', 'POST', 'GET']);
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ podName: 'alice' });
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({ podName: 'alice', webId });
    expect(JSON.parse(calls[2].init?.body as string)).toEqual({ name: 'alice', settings: {
      provisionCode, provisionReceipt: receipt, webId,
    } });
    for (const index of [0, 2, 3]) {
      expect(new Headers(calls[index].init?.headers).get('authorization')).toBe(`CSS-Account-Token ${authorization}`);
      expect(calls[index].init?.credentials).toBe('include');
    }
    expect(new Headers(calls[1].init?.headers).get('authorization')).toBe('Bearer fixture-local-callback');
  });

  const finalized = { webId, pod: podUrl, podResource: `${controls.account.pod}pod-1/`,
    webIdResource: `${baseUrl}.account/account/account-1/webid/link-1/` };
  const local = { webId, podUrl, provisionReceipt: receipt };

  it('requires the authenticated Cloud profile control before making any request', async () => {
    const { calls, fetchImpl } = protocol();
    await expect(prepareManagedLocalAcceptancePod({ ...options,
      controls: { account: { pod: controls.account.pod, bindings: controls.account.bindings } }, fetchImpl,
    })).rejects.toThrow('controls.account.profile');
    expect(calls).toEqual([]);
  });

  it.each([
    ['external identity', { webId: 'https://other.example/card#me', webIdLink: 'link-1' }],
    ['node identity', { webId: `${canonicalBaseUrl}alice/profile/card#me`, webIdLink: 'link-1' }],
    ['whitespace identity', { webId: ` ${webId}`, webIdLink: 'link-1' }],
    ['missing Account link', { webId }],
    ['Cloud error', json({ error: 'profile unavailable' }, 503)],
  ])('stops before Local preparation on %s', async (_label, prepared) => {
    const { calls, fetchImpl } = protocol([prepared]);
    await expect(prepareManagedLocalAcceptancePod({ ...options, fetchImpl })).rejects.toThrow();
    expect(calls.map(({ url }) => url)).toEqual([controls.account.profile]);
  });

  it.each([
    ['different returned WebID', { ...local, webId: `${baseUrl}other/card#me` }],
    ['different returned Pod', { ...local, podUrl: `${canonicalBaseUrl}other/` }],
    ['missing returned identity', { podUrl, provisionReceipt: receipt }],
    ['different receipt WebID', { ...local, provisionReceipt: createProvisionReceipt({
      secret: 'fixture-private-receipt-key', podName: 'alice', podUrl, webId: `${baseUrl}other/card#me`,
    }) }],
    ['URL-equivalent receipt identity', { ...local, provisionReceipt: createProvisionReceipt({
      secret: 'fixture-private-receipt-key', podName: 'alice', podUrl, webId: webId.replace('/identity/', '/%69dentity/'),
    }) }],
    ['different receipt Pod', { ...local, provisionReceipt: createProvisionReceipt({
      secret: 'fixture-private-receipt-key', podName: 'alice', podUrl: `${canonicalBaseUrl}other/`, webId,
    }) }],
    ['different receipt Pod name', { ...local, provisionReceipt: createProvisionReceipt({
      secret: 'fixture-private-receipt-key', podName: 'other', podUrl, webId,
    }) }],
    ['expired receipt', { ...local, provisionReceipt: createProvisionReceipt({
      secret: 'fixture-private-receipt-key', podName: 'alice', podUrl, webId, expiresAt: 1,
    }) }],
    ['malformed receipt', { ...local, provisionReceipt: 'not-a-receipt' }],
  ])('does not finalize Cloud when Local returns %s', async (_label, prepared) => {
    const { calls, fetchImpl } = protocol([{ webId, webIdLink: 'link-1' }, prepared]);
    await expect(prepareManagedLocalAcceptancePod({ ...options, fetchImpl })).rejects.toThrow();
    expect(calls.map(({ url }) => url)).toEqual([controls.account.profile, `${localBaseUrl}provision/pods`]);
  });

  it.each([
    ['different WebID', { ...finalized, webId: `${baseUrl}other/card#me` }],
    ['different Pod', { ...finalized, pod: `${canonicalBaseUrl}other/` }],
    ['missing pointers', { webId, pod: podUrl }],
    ['another Account pointer', { ...finalized, webIdResource: `${baseUrl}.account/account/account-2/webid/link-1/` }],
    ['another origin pointer', { ...finalized, podResource: 'https://other.example/.account/account/account-1/pod/pod-1/' }],
    ['different identity link', { ...finalized, webIdResource: `${baseUrl}.account/account/account-1/webid/link-2/` }],
    ['Cloud signature rejection', json({ error: 'invalid receipt' }, 400)],
  ])('does not accept a successful binding from %s', async (_label, result) => {
    const { calls, fetchImpl } = protocol([{ webId, webIdLink: 'link-1' }, local, result]);
    await expect(prepareManagedLocalAcceptancePod({ ...options, fetchImpl })).rejects.toThrow();
    expect(calls).toHaveLength(3);
  });

  it('rejects an Account binding for the right Pod but a different raw identity', async () => {
    const { calls, fetchImpl } = protocol([{ webId, webIdLink: 'link-1' }, local, finalized,
      { bindings: [{ webId: webId.replace('/identity/', '/%69dentity/'), storageUrl: podUrl }] },
    ]);
    await expect(prepareManagedLocalAcceptancePod({ ...options, fetchImpl })).rejects.toThrow('different WebID/storage binding');
    expect(calls).toHaveLength(4);
  });

  it('requires Account binding publication even when the finalize response has the expected pair', async () => {
    const { calls, fetchImpl } = protocol([{ webId, webIdLink: 'link-1' }, local, finalized,
      json({ error: 'bindings unavailable' }, 503),
    ]);
    await expect(prepareManagedLocalAcceptancePod({ ...options, fetchImpl })).rejects.toThrow('GET Cloud controls.account.bindings HTTP 503');
    expect(calls).toHaveLength(4);
  });

  it('keeps polling past unrelated existing Pods without accepting them', async () => {
    vi.useFakeTimers();
    try {
      const { calls, fetchImpl } = protocol([{ webId, webIdLink: 'link-1' }, local, finalized,
        { bindings: [{ webId, storageUrl: `${canonicalBaseUrl}other/` }] },
        { bindings: [{ webId, storageUrl: `${canonicalBaseUrl}other/` }, { webId, storageUrl: podUrl }] },
      ]);
      const pending = prepareManagedLocalAcceptancePod({ ...options, fetchImpl });
      const check = expect(pending).resolves.toEqual({ webId, storageUrl: podUrl });
      await vi.advanceTimersByTimeAsync(500);
      await check;
      expect(calls).toHaveLength(5);
    } finally { vi.useRealTimers(); }
  });

  it('fails when Account bindings never publish the prepared pair instead of using the finalize response', async () => {
    vi.useFakeTimers();
    try {
      const { calls, fetchImpl } = protocol([{ webId, webIdLink: 'link-1' }, local, finalized,
        ...Array.from({ length: 20 }, () => ({ bindings: [] })),
      ]);
      const pending = prepareManagedLocalAcceptancePod({ ...options, fetchImpl });
      const check = expect(pending).rejects.toThrow('did not publish the Local-managed WebID/storage binding');
      await vi.advanceTimersByTimeAsync(10_000);
      await check;
      expect(calls).toHaveLength(23);
    } finally { vi.useRealTimers(); }
  });

});
