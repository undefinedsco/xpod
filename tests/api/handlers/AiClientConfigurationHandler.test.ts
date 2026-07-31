import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiServer } from '../../../src/api/ApiServer';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';
import {
  AiClientConfigurationService,
  type AiClientId,
} from '../../../src/api/service/AiClientConfigurationService';
import { registerAiClientConfigurationRoutes } from '../../../src/api/handlers/AiClientConfigurationHandler';

interface TestResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader(name: string, value: string): void;
  end(payload?: string): void;
}

type RouteHandler = (request: AuthenticatedRequest, response: TestResponse, params: Record<string, string>) => Promise<void> | void;

const WEB_ID = 'https://pod.example/alice/profile/card#me';
const ENDPOINT = 'https://xpod.example';
const GATEWAY_KEY = 'xpod_gw_v1_super_secret_gateway_key';
const PROVIDER_KEY = 'sk-provider-must-never-appear';

const CLIENTS: AiClientId[] = ['codex', 'claude-code', 'pi', 'codebuddy'];

describe('AiClientConfigurationHandler', () => {
  let tmpDir: string;
  let service: AiClientConfigurationService;
  let routes: Record<string, RouteHandler>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xpod-client-config-'));
    await writeFixtures(tmpDir);
    const verifier = vi.fn(async () => ({
      models: true,
      authenticatedRequest: true,
    }));
    service = new AiClientConfigurationService({
      homeDir: tmpDir,
      backupRoot: path.join(tmpDir, '.xpod', 'client-config-backups'),
      verifyGateway: verifier,
      now: () => new Date('2026-07-31T08:00:00.000Z'),
    });
    const server = createServer();
    routes = server.routes;
    registerAiClientConfigurationRoutes(server.server, { service });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it.each(CLIENTS)('plans %s as a pure redacted operation and preserves unrelated fixture configuration', async (client) => {
    const before = await snapshot(tmpDir);
    const res = response();

    await route('POST /api/ai/client-configuration/:client/plan')(
      jsonRequest({ endpoint: ENDPOINT, model: 'openai/gpt-5', providerCredential: PROVIDER_KEY }, scopedAuth('client-config:write')),
      res,
      { client },
    );

    expect(res.statusCode).toBe(200);
    const plan = JSON.parse(res.body);
    expect(plan.client).toBe(client);
    expect(plan.planId).toMatch(/^aicfg_/);
    expect(plan.backupLocation).toContain('.xpod/client-config-backups');
    expect(plan.confirmation?.required ?? false).toBe(client === 'pi');
    expect(plan.changes.length).toBeGreaterThan(0);
    expect(JSON.stringify(plan)).toContain('[redacted]');
    expect(JSON.stringify(plan)).not.toContain(GATEWAY_KEY);
    expect(JSON.stringify(plan)).not.toContain(PROVIDER_KEY);
    await expect(snapshot(tmpDir)).resolves.toEqual(before);
  });

  it.each(CLIENTS)('applies, verifies, restores, and preserves unrelated %s configuration', async (client) => {
    const plan = await postPlan(client);

    const apply = response();
    await route('POST /api/ai/client-configuration/:client/apply')(
      jsonRequest({
        planId: plan.planId,
        gatewayKey: GATEWAY_KEY,
        providerCredential: PROVIDER_KEY,
        ...(plan.confirmation ? {
          confirmation: {
            token: plan.confirmation.token,
            targetHash: plan.confirmation.targetHash,
          },
        } : {}),
      }, scopedAuth('client-config:write')),
      apply,
      { client },
    );

    expect(apply.statusCode).toBe(200);
    expect(JSON.stringify(JSON.parse(apply.body))).not.toContain(GATEWAY_KEY);
    expect(JSON.stringify(JSON.parse(apply.body))).not.toContain(PROVIDER_KEY);
    await expectClientConfigured(tmpDir, client);
    await expectUnrelatedPreserved(tmpDir, client);

    const verify = response();
    await route('POST /api/ai/client-configuration/:client/verify')(
      jsonRequest({ planId: plan.planId }, scopedAuth('client-config:read')),
      verify,
      { client },
    );
    expect(JSON.parse(verify.body)).toMatchObject({ status: 'configured' });

    await mutateUnrelatedAfterApply(tmpDir, client);
    const restore = response();
    await route('POST /api/ai/client-configuration/:client/restore')(
      jsonRequest({}, scopedAuth('client-config:write')),
      restore,
      { client },
    );

    expect(restore.statusCode).toBe(200);
    expect(JSON.parse(restore.body)).toMatchObject({ status: 'notConfigured' });
    await expectClientRestoredWithoutLosingUserChange(tmpDir, client);

    const secondRestore = response();
    await route('POST /api/ai/client-configuration/:client/restore')(
      jsonRequest({}, scopedAuth('client-config:write')),
      secondRestore,
      { client },
    );
    expect(JSON.parse(secondRestore.body)).toMatchObject({ status: 'notConfigured' });
  });

  it('restores automatically when gateway verification fails after apply', async () => {
    service = new AiClientConfigurationService({
      homeDir: tmpDir,
      backupRoot: path.join(tmpDir, '.xpod', 'client-config-backups'),
      verifyGateway: vi.fn(async () => {
        throw new Error(`upstream rejected ${GATEWAY_KEY}`);
      }),
      now: () => new Date('2026-07-31T08:00:00.000Z'),
    });
    const server = createServer();
    routes = server.routes;
    registerAiClientConfigurationRoutes(server.server, { service });
    const plan = await postPlan('codex');

    const res = response();
    await route('POST /api/ai/client-configuration/:client/apply')(
      jsonRequest({ planId: plan.planId, gatewayKey: GATEWAY_KEY }, scopedAuth('client-config:write')),
      res,
      { client: 'codex' },
    );

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ error: 'verification_failed_restored' });
    expect(JSON.stringify(body)).not.toContain(GATEWAY_KEY);
    expect(await readCodexConfig(tmpDir)).not.toContain('xpod-ai-connection');
    await expectUnrelatedPreserved(tmpDir, 'codex');
  });

  it('rejects unsafe symlink targets before backup or write', async () => {
    await fs.rm(path.join(tmpDir, '.codex', 'config.toml'));
    await fs.symlink('/tmp/xpod-unsafe-target', path.join(tmpDir, '.codex', 'config.toml'));

    const res = response();
    await route('POST /api/ai/client-configuration/:client/plan')(
      jsonRequest({ endpoint: ENDPOINT }, scopedAuth('client-config:write')),
      res,
      { client: 'codex' },
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'unsafe_config_target' });
    await expect(fs.readdir(path.join(tmpDir, '.xpod')).catch(() => [])).resolves.toEqual([]);
  });

  it('denies ordinary Solid callers and permits explicit client-config scoped invocation callers', async () => {
    const denied = response();
    await route('GET /api/ai/client-configuration/:client')(
      jsonRequest(undefined, { type: 'solid', webId: WEB_ID }),
      denied,
      { client: 'codex' },
    );
    expect(denied.statusCode).toBe(403);

    const allowed = response();
    await route('GET /api/ai/client-configuration/:client')(
      jsonRequest(undefined, scopedAuth('client-config:read')),
      allowed,
      { client: 'codex' },
    );
    expect(allowed.statusCode).toBe(200);
    expect(JSON.parse(allowed.body).status).toBe('notConfigured');
  });

  it('reports stale plan conflicts instead of racing over a user edit', async () => {
    const plan = await postPlan('claude-code');
    await fs.writeFile(path.join(tmpDir, '.claude', 'settings.json'), JSON.stringify({
      permissions: { allow: ['Bash(echo safe)'] },
      userEdited: true,
    }, null, 2));

    const res = response();
    await route('POST /api/ai/client-configuration/:client/apply')(
      jsonRequest({ planId: plan.planId, gatewayKey: GATEWAY_KEY }, scopedAuth('client-config:write')),
      res,
      { client: 'claude-code' },
    );

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'configuration_conflict' });
    const current = await fs.readFile(path.join(tmpDir, '.claude', 'settings.json'), 'utf8');
    expect(current).toContain('userEdited');
    expect(current).not.toContain(GATEWAY_KEY);
  });

  it('requires a fresh confirmation token for replacement-sensitive client plans', async () => {
    const plan = await postPlan('pi');
    expect(plan.confirmation).toMatchObject({ required: true });

    const missing = response();
    await route('POST /api/ai/client-configuration/:client/apply')(
      jsonRequest({ planId: plan.planId, gatewayKey: GATEWAY_KEY }, scopedAuth('client-config:write')),
      missing,
      { client: 'pi' },
    );
    expect(missing.statusCode).toBe(409);
    expect(JSON.parse(missing.body)).toEqual({ error: 'confirmation_required' });

    const stale = response();
    await route('POST /api/ai/client-configuration/:client/apply')(
      jsonRequest({
        planId: plan.planId,
        gatewayKey: GATEWAY_KEY,
        confirmation: { token: plan.confirmation.token, targetHash: 'stale' },
      }, scopedAuth('client-config:write')),
      stale,
      { client: 'pi' },
    );
    expect(stale.statusCode).toBe(409);
    expect(JSON.parse(stale.body)).toEqual({ error: 'confirmation_stale' });
  });

  it('verifies managed config after restart only when a recoverable key reference exists', async () => {
    const plan = await postPlan('codex');
    const apply = response();
    await route('POST /api/ai/client-configuration/:client/apply')(
      jsonRequest({ planId: plan.planId, gatewayKey: GATEWAY_KEY }, scopedAuth('client-config:write')),
      apply,
      { client: 'codex' },
    );
    expect(apply.statusCode).toBe(200);

    const restarted = new AiClientConfigurationService({
      homeDir: tmpDir,
      backupRoot: path.join(tmpDir, '.xpod', 'client-config-backups'),
      verifyGateway: vi.fn(),
      now: () => new Date('2026-07-31T08:00:00.000Z'),
    });
    const server = createServer();
    routes = server.routes;
    registerAiClientConfigurationRoutes(server.server, { service: restarted });

    const verify = response();
    await route('POST /api/ai/client-configuration/:client/verify')(
      jsonRequest({}, scopedAuth('client-config:read')),
      verify,
      { client: 'codex' },
    );
    expect(JSON.parse(verify.body)).toMatchObject({
      status: 'unverifiable',
      message: expect.stringContaining('Gateway key is not recoverable'),
    });
  });

  it('restore strips old and current managed values without reviving stale xpod keys', async () => {
    const target = path.join(tmpDir, '.claude', 'settings.json');
    await fs.writeFile(target, JSON.stringify({
      env: {
        KEEP_BEFORE: 'yes',
        ANTHROPIC_BASE_URL: 'https://old-xpod.example/api/ai',
        ANTHROPIC_AUTH_TOKEN: 'old-xpod-secret',
      },
    }, null, 2));
    const plan = await postPlan('claude-code');
    const apply = response();
    await route('POST /api/ai/client-configuration/:client/apply')(
      jsonRequest({ planId: plan.planId, gatewayKey: GATEWAY_KEY }, scopedAuth('client-config:write')),
      apply,
      { client: 'claude-code' },
    );
    expect(apply.statusCode).toBe(200);
    const afterApply = JSON.parse(await fs.readFile(target, 'utf8'));
    afterApply.after = true;
    afterApply.env.KEEP_AFTER = 'yes';
    await fs.writeFile(target, JSON.stringify(afterApply, null, 2));

    const restore = response();
    await route('POST /api/ai/client-configuration/:client/restore')(
      jsonRequest({}, scopedAuth('client-config:write')),
      restore,
      { client: 'claude-code' },
    );

    const restored = JSON.parse(await fs.readFile(target, 'utf8'));
    expect(restored.after).toBe(true);
    expect(restored.env.KEEP_BEFORE).toBe('yes');
    expect(restored.env.KEEP_AFTER).toBe('yes');
    expect(restored.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(restored.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('returns 503 when the local filesystem host capability is not registered', async () => {
    const server = createServer();
    routes = server.routes;
    registerAiClientConfigurationRoutes(server.server, { service: undefined });

    const res = response();
    await route('GET /api/ai/client-configuration/:client')(
      jsonRequest(undefined, scopedAuth('client-config:read')),
      res,
      { client: 'codex' },
    );

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: 'client_configuration_unavailable' });
  });

  async function postPlan(client: AiClientId) {
    const res = response();
    await route('POST /api/ai/client-configuration/:client/plan')(
      jsonRequest({ endpoint: ENDPOINT, model: 'openai/gpt-5' }, scopedAuth('client-config:write')),
      res,
      { client },
    );
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body);
  }

  function route(key: string): RouteHandler {
    const handler = routes[key];
    if (!handler) {
      throw new Error(`Missing route ${key}`);
    }
    return handler;
  }
});

function createServer(): { server: ApiServer; routes: Record<string, RouteHandler> } {
  const routes: Record<string, RouteHandler> = {};
  return {
    routes,
    server: {
      get: vi.fn((route: string, handler: RouteHandler) => { routes[`GET ${route}`] = handler; }),
      post: vi.fn((route: string, handler: RouteHandler) => { routes[`POST ${route}`] = handler; }),
    } as unknown as ApiServer,
  };
}

function jsonRequest(body: unknown, auth: AuthenticatedRequest['auth']): AuthenticatedRequest {
  const req = new PassThrough() as PassThrough & AuthenticatedRequest;
  req.method = 'POST';
  req.url = '/api/ai/client-configuration/codex';
  req.headers = body === undefined ? {} : { 'content-type': 'application/json' };
  req.auth = auth;
  if (body !== undefined) {
    req.end(JSON.stringify(body));
  } else {
    req.end();
  }
  return req;
}

function scopedAuth(scope: 'client-config:read' | 'client-config:write'): AuthenticatedRequest['auth'] {
  return {
    type: 'solid',
    webId: WEB_ID,
    viaGatewayApiKey: true,
    internalInvocation: true,
    gatewayKeyId: 'gak_invocation',
    scopes: scope === 'client-config:read'
      ? ['client-config:read']
      : ['client-config:read', 'client-config:write'],
  };
}

function response(): TestResponse {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    end(payload?: string) {
      this.body = payload ?? '';
    },
  };
}

async function writeFixtures(home: string): Promise<void> {
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.writeFile(path.join(home, '.codex', 'config.toml'), [
    'model = "gpt-5"',
    '[model_providers.openai]',
    'name = "OpenAI"',
    'base_url = "https://api.openai.com/v1"',
    '',
  ].join('\n'));
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    permissions: { allow: ['Bash(echo safe)'] },
    theme: 'dark',
  }, null, 2));
  await fs.mkdir(path.join(home, '.config', 'pi'), { recursive: true });
  await fs.writeFile(path.join(home, '.config', 'pi', 'settings.json'), JSON.stringify({
    provider: { id: 'anthropic', baseUrl: 'https://api.anthropic.com' },
    telemetry: false,
  }, null, 2));
  await fs.mkdir(path.join(home, '.codebuddy'), { recursive: true });
  await fs.writeFile(path.join(home, '.codebuddy', 'config.json'), JSON.stringify({
    providers: { tencent: { enabled: true } },
    ui: { locale: 'zh-CN' },
  }, null, 2));
}

async function snapshot(home: string): Promise<Record<string, string>> {
  const entries = await Promise.all([
    readCodexConfig(home),
    fs.readFile(path.join(home, '.claude', 'settings.json'), 'utf8'),
    fs.readFile(path.join(home, '.config', 'pi', 'settings.json'), 'utf8'),
    fs.readFile(path.join(home, '.codebuddy', 'config.json'), 'utf8'),
  ]);
  return {
    codex: entries[0],
    claude: entries[1],
    pi: entries[2],
    codebuddy: entries[3],
  };
}

async function readCodexConfig(home: string): Promise<string> {
  return fs.readFile(path.join(home, '.codex', 'config.toml'), 'utf8');
}

async function expectClientConfigured(home: string, client: AiClientId): Promise<void> {
  const content = await clientContent(home, client);
  expect(content).toContain('xpod-ai-connection');
  expect(content).toContain(ENDPOINT);
  expect(content).toContain(GATEWAY_KEY);
  expect(content).not.toContain(PROVIDER_KEY);
  const stat = await fs.stat(client === 'codex'
    ? path.join(home, '.codex', 'config.toml')
    : client === 'claude-code'
      ? path.join(home, '.claude', 'settings.json')
      : client === 'pi'
        ? path.join(home, '.config', 'pi', 'settings.json')
        : path.join(home, '.codebuddy', 'config.json'));
  expect((stat.mode & 0o077)).toBe(0);
}

async function expectUnrelatedPreserved(home: string, client: AiClientId): Promise<void> {
  const content = await clientContent(home, client);
  if (client === 'codex') expect(content).toContain('model = "gpt-5"');
  if (client === 'claude-code') expect(content).toContain('Bash(echo safe)');
  if (client === 'pi') expect(content).toContain('"telemetry": false');
  if (client === 'codebuddy') expect(content).toContain('"locale": "zh-CN"');
}

async function mutateUnrelatedAfterApply(home: string, client: AiClientId): Promise<void> {
  if (client === 'codex') {
    await fs.appendFile(path.join(home, '.codex', 'config.toml'), 'user_note = "kept"\n');
    return;
  }
  const file = client === 'claude-code'
    ? path.join(home, '.claude', 'settings.json')
    : client === 'pi'
      ? path.join(home, '.config', 'pi', 'settings.json')
      : path.join(home, '.codebuddy', 'config.json');
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  parsed.userNote = 'kept';
  await fs.writeFile(file, JSON.stringify(parsed, null, 2));
}

async function expectClientRestoredWithoutLosingUserChange(home: string, client: AiClientId): Promise<void> {
  const content = await clientContent(home, client);
  expect(content).not.toContain('xpod-ai-connection');
  expect(content).not.toContain(GATEWAY_KEY);
  expect(content).toContain(client === 'codex' ? 'user_note = "kept"' : '"userNote": "kept"');
  await expectUnrelatedPreserved(home, client);
}

async function clientContent(home: string, client: AiClientId): Promise<string> {
  if (client === 'codex') return readCodexConfig(home);
  if (client === 'claude-code') return fs.readFile(path.join(home, '.claude', 'settings.json'), 'utf8');
  if (client === 'pi') return fs.readFile(path.join(home, '.config', 'pi', 'settings.json'), 'utf8');
  return fs.readFile(path.join(home, '.codebuddy', 'config.json'), 'utf8');
}
