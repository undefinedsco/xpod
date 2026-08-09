import { createServer, type Server } from 'node:http';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { XpodTestStack } from './XpodTestStack';
import { setupAccount, type AccountSetup } from '../integration/helpers/solidAccount';

const readyPrefix = 'XPOD_SETTINGS_FIXTURE_READY ';
const failurePrefix = 'XPOD_SETTINGS_FIXTURE_ERROR ';
const runtimeParent = path.resolve('.test-data/acceptance');
const runtimeRoot = path.join(runtimeParent, `runtime-${process.pid}-${randomUUID()}`);
const fixtureBearerLabels = new Map<string, string>([
  ['Bearer sk-xpod-acceptance-fixture-key', 'primary'],
  ['Bearer sk-xpod-acceptance-fixture-sibling', 'sibling'],
]);

type FixtureModel = { id: string; display_name?: string };

type FixtureAccount = AccountSetup & {
  email: string;
  password: string;
};

type FixtureReady = {
  type: 'ready';
  baseUrl: string;
  fixtureBaseUrl: string;
  controlUrl: string;
  accounts: {
    alice: FixtureAccount;
    bob: FixtureAccount;
  };
};

class OpenAiCompatibleFixture {
  private server?: Server;
  private models: FixtureModel[] = [{
    id: 'fixture-gpt-acceptance',
    display_name: 'Fixture GPT Acceptance',
  }];
  readonly requests: string[] = [];
  readonly authorizedDiscoveries: string[] = [];
  baseUrl = '';

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      this.requests.push(`${request.method ?? 'GET'} ${pathname}`);
      if (request.method === 'GET' && pathname === '/v1/models') {
        const credentialLabel = fixtureBearerLabels.get(request.headers.authorization ?? '');
        if (!credentialLabel) {
          this.writeJson(response, 401, { error: 'missing or invalid fixture bearer credential' });
          return;
        }
        this.authorizedDiscoveries.push(credentialLabel);
        this.writeJson(response, 200, {
          object: 'list',
          data: this.models.map((model) => ({
            object: 'model',
            owned_by: 'xpod-acceptance',
            ...model,
          })),
        });
        return;
      }
      if (pathname === '/control/status' && request.method === 'GET') {
        this.writeJson(response, 200, {
          requests: this.requests,
          modelCount: this.models.length,
          authorizedDiscoveries: this.authorizedDiscoveries,
        });
        return;
      }
      if (pathname === '/control/models' && request.method === 'POST') {
        void this.readJson(request).then((body) => {
          const models = body?.models;
          if (!Array.isArray(models)) {
            this.writeJson(response, 400, { error: 'models must be an array' });
            return;
          }
          this.models = models.flatMap((model): FixtureModel[] => {
            if (!model || typeof model !== 'object' || typeof (model as { id?: unknown }).id !== 'string') return [];
            const displayName = (model as { display_name?: unknown }).display_name;
            return [{
              id: (model as { id: string }).id,
              ...(typeof displayName === 'string' ? { display_name: displayName } : {}),
            }];
          });
          this.writeJson(response, 204, undefined);
        }).catch(() => this.writeJson(response, 400, { error: 'invalid JSON' }));
        return;
      }
      if (pathname === '/control/shutdown' && request.method === 'POST') {
        this.writeJson(response, 204, undefined);
        void shutdown(0);
        return;
      }
      this.writeJson(response, 404, { error: 'fixture route not found' });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not expose a TCP port');
    this.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private writeJson(response: import('node:http').ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, body === undefined ? undefined : { 'content-type': 'application/json' });
    if (body !== undefined) response.end(JSON.stringify(body));
    else response.end();
  }

  private async readJson(request: import('node:http').IncomingMessage): Promise<Record<string, unknown> | undefined> {
    let text = '';
    for await (const chunk of request) text += String(chunk);
    if (!text) return undefined;
    return JSON.parse(text) as Record<string, unknown>;
  }
}

const stack = new XpodTestStack();
const providerFixture = new OpenAiCompatibleFixture();
let shuttingDown = false;

async function main(): Promise<void> {
  await mkdir(runtimeParent, { recursive: true });
  await providerFixture.start();
  await stack.start('local', {
    transport: 'port',
    open: false,
    apiOpen: false,
    envFile: undefined,
    runtimeRoot,
    logLevel: 'error',
    env: {
      XPOD_ACCEPTANCE_ENDPOINTS_ENABLED: 'true',
      XPOD_AI_GATEWAY_OPENAI_BASE_URL: providerFixture.baseUrl,
    },
  });
  const alice = await setupAccount(stack.baseUrl, 'alice');
  const bob = await setupAccount(stack.baseUrl, 'bob');
  if (!alice?.email || !alice.password || !bob?.email || !bob.password) {
    throw new Error('fixture accounts were not created');
  }
  const address = providerFixture.baseUrl.replace(/\/v1$/u, '');
  const ready: FixtureReady = {
    type: 'ready',
    baseUrl: stack.baseUrl,
    fixtureBaseUrl: providerFixture.baseUrl,
    controlUrl: address,
    accounts: {
      alice: alice as FixtureAccount,
      bob: bob as FixtureAccount,
    },
  };
  process.stdout.write(`${readyPrefix}${JSON.stringify(ready)}\n`);
}

async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await stack.stop();
  } finally {
    try {
      await providerFixture.stop();
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }
  process.exit(exitCode);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

// Keep startup diagnostics off stdout: the parent treats stdout as a one-line
// control protocol and retains no credential-bearing logs.
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.warn = (...args: unknown[]) => console.error(...args);

try {
  await main();
} catch {
  process.stdout.write(`${failurePrefix}{"error":"startup_failed"}\n`);
  await shutdown(1).catch(() => {
    process.exitCode = 1;
  });
}
