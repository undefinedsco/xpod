import { errors, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ApiServer, RouteHandler } from '../../src/api/ApiServer';
import type { AuthenticatedRequest } from '../../src/api/middleware/AuthMiddleware';
import { InMemoryStore, type StoreContext } from '../../src/api/chatkit/store';
import { TaskService } from '../../src/api/tasks/TaskService';
import { registerTaskRoutes } from '../../src/api/handlers/TaskHandler';
import { expect, it, vi } from 'vitest';
import { AiConnectionsInvocationKeyIssuer } from '../../src/api/ai-gateway/auth/AiConnectionsInvocationKeyIssuer';
import { AesInvocationTokenCodec } from '../../src/api/ai-gateway/auth/InvocationTokenCodec';
import { acceptPackagedDesktopPermissions, assertOwnedTaskRows, DesktopAcceptanceError, describeFailure,
  publishedFailures, requirePackagedInvocationKey, rendererOwnerFetch, requestPackagedForeignRun } from '../../scripts/accept-packaged-desktop-permissions';
import { acceptMountedPodPermissions, attributeMountedOperation, MountedPermissionError } from '../../scripts/helpers/packaged-desktop-permissions';
import { attributeOidcOperation, OidcApprovalError } from '../../tests/helpers/browserSolidOidc';

import * as packagedSource from '../../scripts/helpers/packaged-desktop-source';
import * as packagedFixture from '../../scripts/helpers/packaged-desktop-fixture';

const MOUNTED_CONDITIONS = ['mounted-runtime', 'service-access', 'target-read', 'parent-policy',
  'grant-apply', 'grant-repeat', 'grant-restore'] as const;

it('publishes only reviewed failure codes and never the underlying error text', () => {
  // An arbitrary upstream error can carry provider keys, opaque tokens or an
  // assertion/credential dump; the public projection must degrade to the
  // generic code and expose none of it. Regex scrubbing is deliberately not the
  // safety mechanism here.
  const secrets = [
    'oc_sk_live_9f2c1d4b8a7e6f5c6d7e8f90',
    'opaque-refresh-token-2f8c1d4b8a7e6f5c6d7e8f90a1b2',
    '{"apiKey":"json-secret-value","assertion":"signed-dump","cookie":"sid=abc"}',
  ];
  for (const secret of secrets) {
    const published = describeFailure(new Error(`upstream rejected ${secret}`));
    expect(published.code).toBe('unclassified');
    expect(JSON.stringify(published)).not.toContain(secret);
    expect(JSON.stringify(publishedFailures([new Error(secret), secret]))).not.toContain(secret);
  }
  // A typed failure publishes its reviewed code and explanation, never its
  // private detail; duplicate codes collapse to one entry.
  const typed = new DesktopAcceptanceError('local-authority', 'private detail with oc_sk_live_9f2c1d4b8a7e6f5c');
  expect(describeFailure(typed)).toEqual({ code: 'local-authority',
    explanation: 'The packaged Local authority or no-public-route proof was missing' });
  expect(JSON.stringify(describeFailure(typed))).not.toContain('oc_sk_live_9f2c1d4b8a7e6f5c');
  expect(publishedFailures([typed, typed])).toEqual([{ code: 'local-authority',
    explanation: 'The packaged Local authority or no-public-route proof was missing' }]);
});

it('publishes only the closed-vocabulary sub-condition the remember gate actually failed', () => {
  // The remember gate is the only reviewed code with a sub-condition. It is a
  // fixed token set, so a CI log/artifact can name which part of the gate failed
  // without ever publishing the private trace booleans behind it.
  const offered = new DesktopAcceptanceError('remember-grant',
    'requested=undefined observed=undefined posted=false with oc_sk_live_9f2c1d4b8a7e6f5c', 'choice-not-offered');
  expect(describeFailure(offered)).toEqual({ code: 'remember-grant',
    explanation: 'The remembered-grant bootstrap did not retain the explicit remember-client choice',
    evidence: 'choice-not-offered' });
  expect(JSON.stringify(describeFailure(offered))).not.toContain('oc_sk_live_9f2c1d4b8a7e6f5c');
  expect(JSON.stringify(describeFailure(offered))).not.toContain('observed=');
  // A bare duplicate code must never replace the entry that carries the
  // sub-condition, and the arbitrary error text stays private.
  expect(publishedFailures([offered, new DesktopAcceptanceError('remember-grant', 'raw-private-detail')]))
    .toEqual([{ code: 'remember-grant',
      explanation: 'The remembered-grant bootstrap did not retain the explicit remember-client choice',
      evidence: 'choice-not-offered' }]);
  // Every other reviewed code stays exactly as reviewed: no sub-condition.
  expect(describeFailure(new DesktopAcceptanceError('consent-binding', 'private'))).toEqual({
    code: 'consent-binding', explanation: 'The actual browser callback or exact Consent binding proof was missing' });
});

it('names the failing browser approval operation with a reviewed code and closed token', () => {
  // RC run 37446580517 failed at pod-a with the generic `unclassified` code: the
  // browser approval helper threw a plain Error, so neither the stdout
  // projection nor the artifact could name the operation. Every approval
  // failure must now publish a reviewed code plus a closed-vocabulary token.
  const blocked = new OidcApprovalError('choice-disabled',
    'Consent remember-client choice is disabled with oc_sk_live_9f2c1d4b8a7e6f5c');
  expect(describeFailure(blocked)).toEqual({ code: 'oidc-approval',
    explanation: 'The packaged browser approval step failed; the reviewed sub-condition names the operation',
    evidence: 'choice-disabled' });
  expect(JSON.stringify(describeFailure(blocked))).not.toContain('oc_sk_live_9f2c1d4b8a7e6f5c');
  expect(publishedFailures([new Error('unclassified upstream'), blocked]))
    .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'oidc-approval', evidence: 'choice-disabled' })]));
  for (const condition of ['choice-not-offered', 'choice-not-retained', 'binding-not-retained', 'binding-unavailable',
    'webid-unavailable', 'multiple-webids', 'second-login-action', 'recovery-boundary', 'login-timeout',
    'account-remember', 'login-navigation', 'account-credentials', 'account-submit', 'webid-entry',
    'remember-choice', 'binding-select', 'approval-action', 'approval-observation'] as const) {
    expect(describeFailure(new OidcApprovalError(condition, 'private detail'))).toEqual({ code: 'oidc-approval',
      explanation: 'The packaged browser approval step failed; the reviewed sub-condition names the operation',
      evidence: condition });
  }
});

it('attributes every real browser operation boundary and never publishes the raw rejection', async () => {
  // The RC failure was a plain external locator rejection. The shared wrapper
  // maps each boundary to one fixed operation token while keeping the raw cause
  // private, so neither stdout nor failure-safe.json can leak key/cookie text.
  const secret = 'oc_sk_live_9f2c1d4b8a7e6f5c6d7e8f90';
  const operations = ['login-navigation', 'account-credentials', 'account-submit', 'webid-entry',
    'remember-choice', 'binding-select', 'approval-action', 'approval-observation'] as const;
  for (const operation of operations) {
    const rejection = new errors.TimeoutError(`locator rejected; apiKey=${secret}; cookie sid=${secret}`);
    const attributed = await attributeOidcOperation(operation, async () => { throw rejection; })
      .catch((error: unknown) => error);
    expect(attributed).toBeInstanceOf(OidcApprovalError);
    expect((attributed as OidcApprovalError).condition).toBe(operation);
    expect((attributed as OidcApprovalError).cause).toBe(rejection);
    expect(describeFailure(attributed)).toEqual({ code: 'oidc-approval',
      explanation: 'The packaged browser approval step failed; the reviewed sub-condition names the operation',
      evidence: operation });
    expect(JSON.stringify(publishedFailures([attributed, new Error(`raw ${secret}`)]))).not.toContain(secret);
  }
});

it('names the failing mounted-permission operation instead of degrading to unclassified', () => {
  // RC 37580705243 reached stage pod-a and published only the generic
  // `unclassified` code: the mounted Pod permission phase threw plain Errors, so
  // neither the stdout projection nor the artifact could name the operation.
  // Every real mounted boundary must now publish the reviewed `pod-permission`
  // code plus one closed-vocabulary token, and never the private detail.
  const secret = 'oc_sk_live_9f2c1d4b8a7e6f5c6d7e8f90';
  const mounted = new MountedPermissionError('grant-apply', `private detail with ${secret}`);
  expect(describeFailure(mounted)).toEqual({ code: 'pod-permission',
    explanation: 'The mounted Pod permission grant or restore proof failed', evidence: 'grant-apply' });
  expect(JSON.stringify(describeFailure(mounted))).not.toContain(secret);
  for (const condition of MOUNTED_CONDITIONS) {
    expect(describeFailure(new MountedPermissionError(condition, 'private detail'))).toEqual({ code: 'pod-permission',
      explanation: 'The mounted Pod permission grant or restore proof failed', evidence: condition });
  }
  expect(JSON.stringify(publishedFailures([mounted, new Error(`raw ${secret}`)]))).not.toContain(secret);
  // A phase whose cleanup also failed arrives as AggregateError[primary,
  // rollback...]; the typed primary must still be named, and an entirely
  // untyped aggregate still degrades to the generic code.
  expect(describeFailure(new AggregateError([mounted, new Error('rollback failed')], 'cleanup failed')))
    .toEqual({ code: 'pod-permission',
      explanation: 'The mounted Pod permission grant or restore proof failed', evidence: 'grant-apply' });
  expect(describeFailure(new AggregateError([new Error('a'), new Error('b')], 'x')).code).toBe('unclassified');
});

it('attributes every real mounted-permission boundary and preserves the inner condition', async () => {
  const secret = 'oc_sk_live_9f2c1d4b8a7e6f5c6d7e8f90';
  for (const condition of MOUNTED_CONDITIONS) {
    const rejection = new Error(`mounted operation rejected; apiKey=${secret}`);
    const attributed = await attributeMountedOperation(condition, async () => { throw rejection; })
      .catch((error: unknown) => error);
    expect(attributed).toBeInstanceOf(MountedPermissionError);
    expect((attributed as MountedPermissionError).condition).toBe(condition);
    expect((attributed as MountedPermissionError).cause).toBe(rejection);
    expect(describeFailure(attributed)).toEqual({ code: 'pod-permission',
      explanation: 'The mounted Pod permission grant or restore proof failed', evidence: condition });
    expect(JSON.stringify(describeFailure(attributed))).not.toContain(secret);
  }
  // An already-typed inner boundary is never replaced by a coarser outer one.
  const inner = new MountedPermissionError('target-read', 'private');
  await expect(attributeMountedOperation('grant-apply', async () => { throw inner; })).rejects.toBe(inner);
});

it('attributes the real mounted-permission caller path rather than publishing unclassified', async () => {
  const secret = 'oc_sk_live_9f2c1d4b8a7e6f5c6d7e8f90';
  const binding = { webId: 'https://a.example/#me', podUrl: 'https://a.example/' };
  const missingTree = { waitForFunction: async () => { throw new Error(`Missing committed React provider tree ${secret}`); } };
  const treeFailure = await acceptMountedPodPermissions(missingTree as unknown as Page, binding)
    .catch((error: unknown) => error);
  expect(treeFailure).toBeInstanceOf(MountedPermissionError);
  expect((treeFailure as MountedPermissionError).condition).toBe('mounted-runtime');
  expect(describeFailure(treeFailure)).toEqual({ code: 'pod-permission',
    explanation: 'The mounted Pod permission grant or restore proof failed', evidence: 'mounted-runtime' });
  expect(JSON.stringify(describeFailure(treeFailure))).not.toContain(secret);

  const badDescriptor = { waitForFunction: async () => ({ evaluate: async () => ({ invalid: true }), dispose: async () => undefined }) };
  const accessFailure = await acceptMountedPodPermissions(badDescriptor as unknown as Page, binding)
    .catch((error: unknown) => error);
  expect(accessFailure).toBeInstanceOf(MountedPermissionError);
  expect((accessFailure as MountedPermissionError).condition).toBe('service-access');
  expect(describeFailure(accessFailure)).toEqual({ code: 'pod-permission',
    explanation: 'The mounted Pod permission grant or restore proof failed', evidence: 'service-access' });
});

it('requires actual independent A task rows and refuses any rows in fresh B', () => {
  assertOwnedTaskRows({ tasks: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }] }, ['a1', 'a2', 'a3']);
  assertOwnedTaskRows({ tasks: [] }, [], true);
  expect(() => assertOwnedTaskRows({ tasks: [] }, ['a1', 'a2', 'a3'])).toThrow('isolation');
  expect(() => assertOwnedTaskRows({ tasks: [{ id: 'a1' }] }, [], true)).toThrow('isolation');
  expect(() => assertOwnedTaskRows({}, [], true)).toThrow('isolation');
});

it('reaches the real Run lookup when checking a foreign Run rather than failing approval validation', async () => {
  const store = new InMemoryStore<StoreContext>();
  const routes = new Map<string, RouteHandler>();
  const server = Object.fromEntries(['get', 'post', 'patch'].map(method => [method,
    (route: string, handler: RouteHandler) => routes.set(`${method} ${route}`, handler)])) as unknown as ApiServer;
  registerTaskRoutes(server, { taskService: new TaskService({ store, executeRuns: false }), runStore: store });
  const ownerFetch = (async (input, init) => {
    const url = new URL(String(input));
    const request = Readable.from([Buffer.from(String(init?.body))]) as AuthenticatedRequest;
    request.url = url.pathname + url.search;
    request.auth = { type: 'solid', webId: 'https://cloud.example/b/profile/card#me' };
    let status = 0;
    let body = '';
    const response = { set statusCode(code: number) { status = code; }, setHeader: vi.fn(),
      writeHead: (code: number) => { status = code; }, end: (value: string) => { body = value; } } as unknown as ServerResponse;
    await routes.get(`${init?.method?.toLowerCase()} ${url.pathname}`)!(request, response, {});
    return new Response(body, { status });
  }) as typeof fetch;
  const result = await requestPackagedForeignRun(ownerFetch, 'https://local.example/',
    'https://pod.example/a/run#old', 'https://pod.example/a/approval#original');
  expect(result.status).toBe(400);
  expect(await result.json()).toMatchObject({ error: 'Run not found', taskResumeStage: 'route_run_read' });
});

it('retains the original failing stage and cannot emit public evidence from an invalid source', async () => {
  const parent = path.join(process.cwd(), '.test-data', 'packaged-desktop-runner');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'failed-'));
  const evidenceFile = path.join(directory, 'public.json');
  try {
    await expect(acceptPackagedDesktopPermissions({ archive: 'absent', version: '0.4.26', sourceSha: 'invalid',
      issuer: 'https://id.example/', keyFile: 'absent', privateDirectory: directory, evidenceFile })).rejects.toThrow('private evidence retained');
    const failure = JSON.parse(await readFile(path.join(directory, 'failure-private.json'), 'utf8'));
    expect(failure.stage).toBe('input');
    // The redacted summary stays available for the workflow log/artifact even
    // though no public evidence was produced.
    const safeFile = path.join(directory, 'failure-safe.json');
    const safe = JSON.parse(await readFile(safeFile, 'utf8'));
    expect(safe).toMatchObject({ schemaVersion: 1, kind: 'desktop-permission-failure', version: '0.4.26', stage: 'input' });
    expect(safe.failures).toEqual([{ code: 'invalid-arguments',
      explanation: 'The packaged desktop runner arguments failed validation' }]);
    expect((await stat(safeFile)).mode & 0o777).toBe(0o644);
    await expect(readFile(evidenceFile)).rejects.toHaveProperty('code', 'ENOENT');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('preserves mounted attribution through the driver final failure projection', async () => {
  const parent = path.join(process.cwd(), '.test-data', 'packaged-desktop-runner');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'projection-'));
  const keyFile = path.join(directory, 'provider.env');
  const secret = 'synthetic-provider-key-for-regression';
  const mounted = new MountedPermissionError('mounted-runtime', `private ${secret}`);
  const verify = vi.spyOn(packagedSource, 'verifyPackagedSourceCheckout').mockResolvedValue(undefined);
  const launch = vi.spyOn(packagedFixture, 'launchOwnedPackagedDesktop')
    .mockRejectedValue(new AggregateError([mounted, new Error('private cleanup')], 'private aggregate'));
  try {
    await writeFile(keyFile, `DEEPSEEK_API_KEY=${secret}\n`, { mode: 0o600 });
    const failure = await acceptPackagedDesktopPermissions({ archive: 'synthetic-launch-rejection',
      version: '0.4.30', sourceSha: 'a'.repeat(40), issuer: 'https://id.example/', keyFile,
      privateDirectory: directory, evidenceFile: path.join(directory, 'public.json') })
      .catch((error: unknown) => error);
    const expected = { code: 'pod-permission',
      explanation: 'The mounted Pod permission grant or restore proof failed', evidence: 'mounted-runtime' };
    expect(describeFailure(failure)).toEqual(expected);
    const safe = JSON.parse(await readFile(path.join(directory, 'failure-safe.json'), 'utf8'));
    expect(safe).toMatchObject({ stage: 'launch', failures: [expected] });
    expect(JSON.stringify(safe)).not.toContain(secret);
    expect(JSON.stringify(describeFailure(failure))).not.toContain(secret);
    const diagnostic = await readFile(path.join(directory, 'failure-private.json'), 'utf8');
    expect(diagnostic).toContain(secret);
    expect((await stat(path.join(directory, 'failure-private.json'))).mode & 0o777).toBe(0o600);
    await expect(readFile(path.join(directory, 'public.json'))).rejects.toHaveProperty('code', 'ENOENT');
  } finally {
    verify.mockRestore(); launch.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

it('consumes real Pod-bound issuer credentials through the packaged acceptance boundary', async () => {
  const codec = new AesInvocationTokenCodec({ active: { kid: 'test', secret: 'packaged-invocation-contract' } });
  const issuer = new AiConnectionsInvocationKeyIssuer({ codec, deployment: 'local', baseUrl: 'https://gateway.example/v1' });
  const webId = 'https://identity.example/alice/profile/card#me';
  const bindings = ['https://storage.example/a/', 'https://storage.example/b/'];
  const keys: string[] = [];
  for (const podUrl of bindings) {
    const invocation = await issuer.issue({ auth: { type: 'solid', webId, authorizedPodUrl: podUrl } });
    const key = requirePackagedInvocationKey({ invocation });
    expect(key).toBe(invocation.apiKey);
    expect(codec.decode(key)).toMatchObject({ webId, podUrl, scopes: ['models:read', 'inference:write'] });
    keys.push(key);
  }
  expect(keys[0]).not.toBe(keys[1]);
});

it('fails closed for absent or non-canonical packaged invocation credentials', () => {
  for (const descriptor of [null, {}, { invocation: {} }, { invocation: { token: 'legacy-only' } },
    { invocation: { apiKey: '' } }, { invocation: { apiKey: '   ' } }, { invocation: { apiKey: 42 } }]) {
    expect(() => requirePackagedInvocationKey(descriptor)).toThrow(DesktopAcceptanceError);
    try { requirePackagedInvocationKey(descriptor); } catch (error) {
      expect(describeFailure(error)).toEqual({ code: 'pod-permission',
        explanation: 'The mounted Pod permission grant or restore proof failed', evidence: 'service-access' });
    }
  }
});


it('requires two independent Cloud WebIDs for the two-Pod isolation claim', async () => {
  const { assertIndependentPackagedBindings } = await import('../../scripts/accept-packaged-desktop-permissions');
  const issuer = 'https://cloud.example/';
  const a = { webId: issuer + 'a/profile/card#me', storageUrl: 'https://node.example/a/' };
  const b = { webId: issuer + 'b/profile/card#me', storageUrl: 'https://node.example/b/' };
  expect(() => assertIndependentPackagedBindings([a, b], issuer)).not.toThrow();
  for (const pair of [[a, { ...b, webId: a.webId }], [a, { ...b, storageUrl: a.storageUrl }],
    [a, { ...b, webId: 'https://foreign.example/card#me' }], [a]]) {
    expect(() => assertIndependentPackagedBindings(pair, issuer)).toThrow('identity/storage');
  }
});


it('forwards caller cancellation through the renderer without replacing its deadline', async () => {
  let requestStarted!: () => void;
  const started = new Promise<void>(resolve => { requestStarted = resolve; });
  const server = createServer((request, response) => {
    expect(request.headers.authorization).toBe('Bearer fixture-owner-key');
    expect(request.headers['x-xpod-pod-url']).toBe('https://pod.example/alice/');
    requestStarted();
    const timer = setTimeout(() => { response.setHeader('content-type', 'application/json'); response.end('{}'); }, 250);
    response.on('close', () => clearTimeout(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing owned test address');
  const gateway = `http://127.0.0.1:${address.port}/`;
  const dispose = vi.fn(async () => undefined);
  const page = {
    evaluateHandle: async (fn: () => AbortController) => {
      const value = fn();
      return { value, evaluate: async (fn: (controller: AbortController) => unknown) => fn(value), dispose };
    },
    evaluate: async (fn: Function, input: { controller?: { value: AbortController } }) =>
      fn({ ...input, ...(input.controller ? { controller: input.controller.value } : {}) }),
  } as unknown as Page;
  vi.stubGlobal('window', { location: { origin: new URL(gateway).origin } });
  try {
    const controller = new AbortController();
    const ownerFetch = rendererOwnerFetch(page, gateway, 'https://pod.example/alice/', 'fixture-owner-key');
    const pending = ownerFetch(new URL('api/tasks/resume', gateway), { signal: controller.signal });
    const rejection = expect(pending).rejects.toThrow('fixture-cancelled');
    await started;
    controller.abort(new Error('fixture-cancelled'));
    await rejection;
    expect(dispose).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});


it('does not start a renderer request when the caller has already cancelled it', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled-before-renderer');
  controller.abort(reason);
  const evaluateHandle = vi.fn();
  const page = { evaluateHandle } as unknown as Page;
  await expect(rendererOwnerFetch(page, 'http://127.0.0.1:41234/', 'https://pod.example/alice/', 'fixture-key')(
    'http://127.0.0.1:41234/api/tasks', { signal: controller.signal },
  )).rejects.toBe(reason);
  expect(evaluateHandle).not.toHaveBeenCalled();
});
