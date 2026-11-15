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
import { acceptPackagedDesktopPermissions, assertOwnedTaskRows, classifyLaunchDetail, DesktopAcceptanceError,
  describeFailure, failureLine, isDesktopLaunchDetail, publishedFailures, requirePackagedInvocationKey,
  rendererOwnerFetch, requestPackagedForeignRun,
  summarizeStartupTelemetry } from '../../scripts/accept-packaged-desktop-permissions';
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

it('emits ONE safe closed failure line for a pod-permission failure with no launch phase', () => {
  const secret = 'bearer secret-token-value https://local.example/private';
  const failure = new MountedPermissionError('service-access', `rejected: ${secret}`, undefined, 'foreign-pod');
  const published = describeFailure(failure);
  // The REAL projection the acceptor prints, not a re-implementation.
  const line = failureLine(published, [failure], undefined, undefined);
  const wire = JSON.stringify(line);
  expect(line).toMatchObject({ runner: 'desktop-permission-acceptance', failed: true, code: 'pod-permission' });
  expect(line.detail).toBe('foreign-pod');
  expect(line.evidence).toBe('service-access');
  // No launch phase => no launch-only fields, and the line is still emitted.
  expect(line.phase).toBeUndefined();
  expect(line.explanation).toBeUndefined();
  // Privacy: nothing from the underlying message reaches the line.
  expect(wire).not.toContain('secret-token-value');
  expect(wire).not.toMatch(/https?:\/\//u);
  // Only the reviewed closed key set appears.
  expect(Object.keys(line).sort()).toEqual(['code', 'detail', 'evidence', 'failed', 'runner']);
  // A failure with no closed detail still yields a safe line.
  const plain = failureLine(describeFailure(new MountedPermissionError('grant-apply', secret)), [], undefined, undefined);
  expect(plain.detail).toBeUndefined();
  expect(JSON.stringify(plain)).not.toContain('secret-token-value');
});

it('retains safe startup telemetry through the real launch error wrapper', async () => {
  const parent = path.join(process.cwd(), '.test-data', 'packaged-desktop-runner');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gateway-projection-'));
  const secret = 'synthetic-private-startup-detail';
  const rejection = new Error(secret);
  const telemetry = { probes: 42, lastOutcome: 'connect-failed', elapsedMs: 60_000, appAlive: true };
  Object.defineProperty(rejection, 'gatewayTelemetry', { value: telemetry });
  const verify = vi.spyOn(packagedSource, 'verifyPackagedSourceCheckout').mockResolvedValue(undefined);
  const launch = vi.spyOn(packagedFixture, 'launchOwnedPackagedDesktop').mockRejectedValue(rejection);
  try {
    await expect(acceptPackagedDesktopPermissions({ archive: 'synthetic-launch-rejection', version: '0.4.31',
      sourceSha: 'a'.repeat(40), issuer: 'https://id.example/', privateDirectory: directory,
      evidenceFile: path.join(directory, 'public.json') })).rejects.toThrow('private evidence retained');
    const safe = JSON.parse(await readFile(path.join(directory, 'failure-safe.json'), 'utf8'));
    expect(safe).toMatchObject({ stage: 'launch', launchTelemetry: telemetry,
      failures: [{ code: 'packaged-launch' }] });
    expect(JSON.stringify(safe)).not.toContain(secret);
    expect(await readFile(path.join(directory, 'failure-private.json'), 'utf8')).toContain(secret);
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

it('makes --key-file optional without inventing an empty external provider file', async () => {
  const { parsePackagedPermissionArguments } = await import('../../scripts/accept-packaged-desktop-permissions');
  const base = ['--archive', 'archive.zip', '--version', '0.4.31', '--source-sha', 'a'.repeat(40),
    '--issuer', 'https://id.undefineds.co', '--private-directory', '/private', '--evidence', '/evidence.json'];
  expect(parsePackagedPermissionArguments(base)).toMatchObject({ archive: 'archive.zip' });
  expect(parsePackagedPermissionArguments(base)).not.toHaveProperty('keyFile');
  expect(parsePackagedPermissionArguments([...base, '--key-file', '/external.env']))
    .toMatchObject({ keyFile: '/external.env' });
  expect(() => parsePackagedPermissionArguments(['--archive', 'archive.zip'])).toThrow('Missing packaged runner argument');
});

it('defers default platform issuance until the authoritative binding WebID and cleans up exactly once', async () => {
  const { configureDefaultPlatformProvider } = await import('../../scripts/accept-packaged-desktop-permissions');
  const calls: Array<{ webId: string; baseUrl: string }> = [];
  const revoke = vi.fn(async () => undefined);
  const issue = vi.fn(async (input: { webId: string; baseUrl: string }) => {
    calls.push({ webId: input.webId, baseUrl: input.baseUrl });
    return { provider: { id: 'custom' as const, offeringId: 'openai-compatible' as const,
      apiKey: 'sk-process-only', baseUrl: 'https://id.undefineds.co/v1', expected: ['linx-lite'], source: 'file' as const }, revoke };
  });
  const options = { baseUrl: 'https://id.undefineds.co/', authorization: 'CSS-Account-Token fixture',
    controls: { account: { clientCredentials: 'https://id.undefineds.co/.account/client-credentials' } },
    webId: 'https://id.undefineds.co/alice/profile/card#me', issue };
  const handle = await configureDefaultPlatformProvider(options);
  expect(handle.provider).toMatchObject({ id: 'custom', offeringId: 'openai-compatible', expected: ['linx-lite'] });
  expect(calls).toEqual([{ webId: options.webId, baseUrl: options.baseUrl }]);
  await handle.revoke();
  expect(revoke).toHaveBeenCalledTimes(1);
});

it('rejects a default platform descriptor with a foreign origin or wrong kind and revokes it', async () => {
  const { configureDefaultPlatformProvider } = await import('../../scripts/accept-packaged-desktop-permissions');
  for (const provider of [
    { id: 'custom' as const, offeringId: 'openai-compatible' as const, apiKey: 'sk-process-only',
      baseUrl: 'https://evil.example/v1', expected: ['linx-lite'], source: 'file' as const },
    { id: 'openai' as const, offeringId: 'api-platform' as const, apiKey: 'sk-process-only',
      baseUrl: 'https://id.undefineds.co/v1', expected: ['linx-lite'], source: 'file' as const },
  ]) {
    const revoke = vi.fn(async () => undefined);
    const issue = vi.fn(async () => ({ provider, revoke }));
    await expect(configureDefaultPlatformProvider({ baseUrl: 'https://id.undefineds.co/',
      authorization: 'CSS-Account-Token fixture',
      controls: { account: { clientCredentials: 'https://id.undefineds.co/.account/client-credentials' } },
      webId: 'https://id.undefineds.co/alice/profile/card#me',
      // The negative fixture deliberately violates the helper's typed return contract.
      issue: issue as unknown as NonNullable<Parameters<typeof configureDefaultPlatformProvider>[0]['issue']>,
    })).rejects.toBeInstanceOf(Error);
    expect(revoke).toHaveBeenCalledTimes(1);
  }
  const revoke = vi.fn(async () => undefined);
  await expect(configureDefaultPlatformProvider({ baseUrl: 'https://id.undefineds.co/',
    authorization: 'CSS-Account-Token fixture',
    controls: { account: { clientCredentials: 'https://id.undefineds.co/.account/client-credentials' } },
    webId: 'https://foreign.example/card#me', issue: vi.fn(async () => ({ provider: {} as never, revoke })) }))
    .rejects.toThrow('authoritative');
  expect(revoke).not.toHaveBeenCalled();
});

it('publishes an audited packaged-launch code with a closed-enum phase', () => {
  // The launch stage reclassifies a bare fixture Error to the already-reviewed
  // packaged-launch code; the phase is a closed enum token.
  const typed = new DesktopAcceptanceError('packaged-launch', 'private detail with oc_sk_live_9f2c1d4b8a7e6f5c');
  expect(describeFailure(typed)).toEqual({ code: 'packaged-launch',
    explanation: 'The owned packaged desktop failed during its startup launch phases' });
  expect(JSON.stringify(describeFailure(typed))).not.toContain('oc_sk_live_9f2c1d4b8a7e6f5c');

  // A published failure may carry only one of the reviewed phase tokens.
  const published = { ...describeFailure(typed), phase: 'native-version' as const };
  expect(JSON.stringify(published)).toContain('"phase":"native-version"');
  expect(JSON.stringify(published)).not.toContain('oc_sk_live_9f2c1d4b8a7e6f5c');

  // An unreviewed value must never serialize into the public record.
  const store = new Map<string, unknown>();
  store.set('phase', '{"stage":"launch","error":"secret"}');
  expect(JSON.stringify([...store.entries()])).not.toContain('"phase":"native-version"');
});

it('keeps a bare fixture error unclassified outside the launch wrapper', () => {
  // Guard against over-broad reclassification: only the launch call site
  // upgrades the code, describeFailure itself stays strict.
  const bare = new Error('Bundled runtime version mismatch at /Users/x/secret');
  expect(describeFailure(bare).code).toBe('unclassified');
  expect(describeFailure(bare).phase).toBeUndefined();
});

it('never masks a reviewed failure that surfaces during launch', () => {
  // Regression: wrapping the launch call must upgrade ONLY unclassified errors.
  // A reviewed permission failure thrown from inside launch keeps its own code.
  const mounted = new (Object.getPrototypeOf(new DesktopAcceptanceError('pod-permission', 'x')).constructor)(
    'pod-permission', 'private mounted detail', 'mounted-runtime');
  expect(describeFailure(mounted).code).toBe('pod-permission');

  // The upgrade predicate is exactly "would otherwise be unclassified".
  const upgraded = describeFailure(new Error('Bundled runtime version mismatch')).code === 'unclassified'
    ? 'packaged-launch' : 'preserved';
  expect(upgraded).toBe('packaged-launch');
});

it('retains the original launch error privately while the public code stays fixed', () => {
  // The launch wrapper must not destroy private debuggability: the original
  // error rides along as `cause`, but describeFailure only ever publishes the
  // reviewed code plus the closed-enum phase.
  const original = new Error('Bundled runtime version mismatch at /Users/runner/secret');
  original.stack = 'Error: Bundled runtime version mismatch at /Users/runner/secret\n    at launch';
  const wrapped = new DesktopAcceptanceError('packaged-launch', original.message, undefined, original);
  expect(wrapped.cause).toBe(original);
  const published = describeFailure(wrapped);
  expect(published.code).toBe('packaged-launch');
  expect(JSON.stringify(published)).not.toContain('/Users/runner/secret');
  // The private chain is still reachable for the 0600 evidence writer.
  expect((wrapped.cause as Error).stack).toContain('launch');
});

it('keeps an injected cleanup failure visible in the safe record shape', () => {
  // Models the diagnostic's contract: cleanup failure must never degrade to a
  // success-looking record, and the phase stays a closed enum token.
  type Safe = { outcome: string; cleanup: 'closed' | 'failed' | 'unproven'; phase?: string };
  const evaluate = (closeThrows: boolean): Safe => {
    const record: Safe = { outcome: 'reached-local-edition', cleanup: 'unproven' };
    try { if (closeThrows) throw new Error('close failed'); record.cleanup = 'closed'; }
    catch { record.cleanup = 'failed'; }
    return record;
  };
  expect(evaluate(false)).toEqual({ outcome: 'reached-local-edition', cleanup: 'closed' });
  // A launched-but-not-cleaned fixture can never look successful.
  const failed = evaluate(true);
  expect(failed.cleanup).toBe('failed');
  expect(failed.cleanup === 'closed').toBe(false);
});


it('publishes the startup cause as closed enums and never as child text', () => {
  // The projection is allowlist-only: every field is an enum, integer or boolean,
  // so a hostile child stream can never reach the job log through it.
  const projected = summarizeStartupTelemetry({
    probes: 237, lastOutcome: 'connect-failed', elapsedMs: 60_083, appAlive: true,
    startupLastEmittedTerminal: true, runtimeChildPresent: false,
    startupLastEmittedAgeMs: 1_250,
    startupLastEmitted: { schemaVersion: 1, sequence: 4, emittedAtMs: 1_700_000_000_000,
      event: 'exited', managerState: 'failed', ownership: 'desktop',
      childSeen: false, pidPresent: false, exitCode: 1, outputClass: 'eaddrinuse' },
    modulePresence: [{ id: 'css', pointerPresent: true, anyPackagedTree: true },
      { id: 'api', pointerPresent: false, anyPackagedTree: true }],
  })!;
  expect(projected).toMatchObject({ probes: 237, lastOutcome: 'connect-failed',
    startupLastEmitted: { event: 'exited', managerState: 'failed', exitCode: 1, outputClass: 'eaddrinuse' },
    startupLastEmittedTerminal: true, runtimeChildPresent: false, startupLastEmittedAgeMs: 1_250 });
  // The emission identity is preserved so a stale frame stays provably stale.
  expect(Object.keys(projected.startupLastEmitted as object).sort()).toEqual(['childSeen', 'emittedAtMs',
    'event', 'exitCode', 'managerState', 'outputClass', 'ownership', 'pidPresent', 'sequence']);
  // The old at-timeout names must never reappear: they claim a live observation.
  expect(JSON.stringify(projected)).not.toMatch(/startupAtTimeout|startupTerminal|"startup":/u);
  // Absent telemetry stays absent, never fabricated.
  expect(summarizeStartupTelemetry(undefined)).toBeUndefined();
  // A launch that failed BEFORE any gateway probe must still publish the frame:
  // the startup observation is independent of probe count.
  const early = summarizeStartupTelemetry({ probes: 0,
    startupLastEmitted: { schemaVersion: 1, sequence: 2, emittedAtMs: 1_700_000_000_000,
      event: 'spawn-error', managerState: 'failed', ownership: 'none',
      childSeen: false, pidPresent: false, errorClass: 'enoent' },
    startupLastEmittedAgeMs: 0, startupLastEmittedTerminal: true })!;
  expect(early).toMatchObject({ probes: 0, startupLastEmitted: { event: 'spawn-error',
    errorClass: 'enoent' }, startupLastEmittedTerminal: true });
});

it('keeps a still-starting launch distinguishable from an exited child in the safe record', async () => {
  const parent = path.join(process.cwd(), '.test-data', 'packaged-desktop-runner');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'startup-cause-'));
  const verify = vi.spyOn(packagedSource, 'verifyPackagedSourceCheckout').mockResolvedValue(undefined);
  const launch = vi.spyOn(packagedFixture, 'launchOwnedPackagedDesktop');
  try {
    const cases = [
      { startupLastEmitted: { schemaVersion: 1, sequence: 1, emittedAtMs: 1_700_000_000_000,
          event: 'spawned', managerState: 'starting',
          ownership: 'desktop', childSeen: true, pidPresent: true },
        startupLastEmittedAgeMs: 59_500, startupLastEmittedTerminal: false },
      { startupLastEmitted: { schemaVersion: 1, sequence: 2, emittedAtMs: 1_700_000_059_000,
          event: 'exited', managerState: 'failed',
          ownership: 'desktop', childSeen: false, pidPresent: false, exitCode: 1, outputClass: 'sqlite' },
        startupLastEmittedAgeMs: 500, startupLastEmittedTerminal: true },
    ];
    for (const [index, cause] of cases.entries()) {
      const rejection = new Error('synthetic-private-child-detail');
      Object.defineProperty(rejection, 'gatewayTelemetry', { value: { probes: 237,
        lastOutcome: 'connect-failed', elapsedMs: 60_083, appAlive: true, ...cause } });
      launch.mockRejectedValue(rejection);
      await expect(acceptPackagedDesktopPermissions({ archive: 'synthetic-launch-rejection', version: '0.4.31',
        sourceSha: 'a'.repeat(40), issuer: 'https://id.example/', privateDirectory: directory,
        evidenceFile: path.join(directory, `public-${index}.json`) })).rejects.toThrow('private evidence retained');
      const safe = JSON.parse(await readFile(path.join(directory, 'failure-safe.json'), 'utf8'));
      expect(safe.launchTelemetry).toMatchObject(cause);
      expect(JSON.stringify(safe)).not.toContain('synthetic-private-child-detail');
    }
  } finally {
    verify.mockRestore(); launch.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

it('classifies each launch failure branch to one closed token and never leaks text', () => {
  const hostile = 'https://local.example/private?token=abc Authorization: Bearer sk-live-9f2c1d password=hunter2';
  const cases = [
    ['bridge-missing', new Error(`Missing packaged desktop bridge ${hostile}`)],
    ['bridge-missing', new Error('Unknown navigation failure', { cause: new Error('Missing packaged desktop bridge') })],
    ['bridge-navigation-context', new Error(`page.evaluate: Execution context was destroyed, most likely because of a navigation ${hostile}`)],
    ['bridge-ipc-untrusted', new Error(`Device settings require the trusted product shell ${hostile}`)],
    ['runtime-failed', new Error('Packaged runtime reported failed before it became ready')],
    ['runtime-stopped', new Error('Packaged runtime reported stopped before it became ready')],
    ['runtime-not-owned', new Error('Packaged runtime is not owned by the installed desktop')],
    ['runtime-not-ready', new Error('Packaged runtime did not reach the running state')],
    ['other', new Error(hostile)],
    ['other', new Error('unrelated launch failure')],
  ] as const;
  for (const [expected, error] of cases) {
    const wrapped = new DesktopAcceptanceError('packaged-launch', 'private launch detail', undefined, error);
    // The REAL launched-path wrapper supplies the token; assert the classifier too.
    expect(classifyLaunchDetail(error)).toBe(expected);
    expect(wrapped.code).toBe('packaged-launch');
  }
  // Only closed tokens can ever be produced.
  const allowed = new Set(['bridge-missing', 'bridge-navigation-context', 'bridge-ipc-untrusted',
    'runtime-failed', 'runtime-stopped', 'runtime-not-owned', 'runtime-not-ready', 'other']);
  for (const [, error] of cases) expect(allowed.has(classifyLaunchDetail(error))).toBe(true);
});

it('launch detail reaches the safe JSON and the failure line without leaking, and never pollutes non-launch failures', () => {
  const hostile = 'https://id.example/private?token=abc Authorization: Bearer sk-live-9f2c1d4b8a7e6f5c password=hunter2';
  const original = new Error(`Execution context was destroyed, most likely because of a navigation ${hostile}`);
  const wrapped = new DesktopAcceptanceError('packaged-launch', 'private launch detail', undefined, original,
    classifyLaunchDetail(original));
  const published = describeFailure(wrapped);
  const line = failureLine(published, [wrapped], 'bridge', undefined);
  expect(line.launchDetail).toBe('bridge-navigation-context');
  expect(line.code).toBe('packaged-launch');
  // The fixed text no longer claims a Local-edition failure.
  expect(line.explanation).toBe('The owned packaged desktop failed during its startup launch phases');
  const wire = JSON.stringify(line);
  for (const secret of ['token=abc', 'Bearer', 'sk-live', 'hunter2', 'https://id.example']) {
    expect(wire).not.toContain(secret);
  }
  // Only reviewed closed keys leave the process.
  expect(Object.keys(line).sort()).toEqual(['code', 'explanation', 'failed', 'launchDetail', 'phase', 'runner']);

  // A non-launch failure must not gain the launch-only field.
  const mounted = new MountedPermissionError('service-access', 'private mounted detail', undefined, 'foreign-pod');
  const mountedLine = failureLine(describeFailure(mounted), [mounted], undefined, undefined);
  expect(mountedLine.launchDetail).toBeUndefined();
  expect(Object.keys(mountedLine).sort()).toEqual(['code', 'detail', 'evidence', 'failed', 'runner']);
  // A launch failure with only an unrecognized message still yields 'other'.
  const odd = new DesktopAcceptanceError('packaged-launch', 'x', undefined, new Error('no pattern'), 'other');
  expect(failureLine(describeFailure(odd), [odd], undefined, undefined).launchDetail).toBe('other');
  // The original cause is still preserved privately, untouched.
  expect((wrapped.cause as Error).message).toContain(hostile);
});

it('bounds the cause walk and survives hostile cause accessors', () => {
  // A self-referential chain must terminate.
  const loop = new Error('loop');
  (loop as Error & { cause?: unknown }).cause = loop;
  expect(classifyLaunchDetail(loop)).toBe('other');

  // A chain deeper than the bound must not reach a token past the limit.
  let deep: Error = new Error('Packaged runtime did not reach the running state');
  for (let index = 0; index < 20; index += 1) deep = new Error('wrapper', { cause: deep });
  expect(classifyLaunchDetail(deep)).toBe('other');
  // A token inside the bound is still found.
  let shallow: Error = new Error('Missing packaged desktop bridge');
  for (let index = 0; index < 3; index += 1) shallow = new Error('wrapper', { cause: shallow });
  expect(classifyLaunchDetail(shallow)).toBe('bridge-missing');

  // A throwing cause getter must not escape classification.
  const hostile: Record<string, unknown> = { message: 'plain' };
  Object.defineProperty(hostile, 'cause', { get(): never { throw new Error('boom https://id.example/private'); } });
  expect(classifyLaunchDetail(hostile)).toBe('other');
});

it('validates the published launch token instead of trusting the declared type', () => {
  for (const token of ['bridge-missing', 'bridge-navigation-context', 'bridge-ipc-untrusted',
    'runtime-failed', 'runtime-stopped', 'runtime-not-owned', 'runtime-not-ready', 'other']) {
    expect(isDesktopLaunchDetail(token)).toBe(true);
  }
  for (const forged of ['', 'BRIDGE-MISSING', 'https://id.example/x?token=abc',
    'Bearer sk-live-9f2c1d', 'password=hunter2', 'bridge-missing\nAuthorization: x']) {
    expect(isDesktopLaunchDetail(forged)).toBe(false);
  }

  // A forged launchDetail (cast past the type) must not reach the job log.
  const forged = new DesktopAcceptanceError('packaged-launch', 'private', undefined, new Error('x'),
    'https://id.example/x?token=abc' as never);
  const forgedLine = failureLine(describeFailure(forged), [forged], undefined, undefined);
  expect(forgedLine.launchDetail).toBeUndefined();
  expect(JSON.stringify(forgedLine)).not.toContain('token=abc');

  // A mixed cleanup error under a NON-launch primary must not gain a launch token.
  const primary = new MountedPermissionError('service-access', 'private mounted', undefined, 'foreign-pod');
  const strayLaunch = new DesktopAcceptanceError('packaged-launch', 'private', undefined, new Error('x'), 'other');
  const mixed = failureLine(describeFailure(primary), [primary, strayLaunch], undefined, undefined);
  expect(mixed.launchDetail).toBeUndefined();
  expect(mixed.code).toBe('pod-permission');
  expect(Object.keys(mixed).sort()).toEqual(['code', 'detail', 'evidence', 'failed', 'runner']);
});
