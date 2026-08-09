import { drizzle, type SolidAuthSession, type SolidDatabase } from '@undefineds.co/drizzle-solid';
import { aiModelResource, aiProviderResource, credentialResource } from '@undefineds.co/models';
import {
  ClaudeCodeConfigAdapter,
  CodeBuddyConfigAdapter,
  CodexConfigAdapter,
  PiConfigAdapter,
  type AiClientConfigAdapter,
} from '@undefineds.co/ai-connections/client-config';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { XpodTestStack } from '../tests/helpers/XpodTestStack';
import { loginWithClientCredentials, setupAccount } from '../tests/integration/helpers/solidAccount';
import { createXpodAiConnectionsClient } from '../ui/src/api/ai-connections';
import { createXpodAiConnectionsPodStore } from '../ui/src/extensions/XpodAiConnectionsPodStore';

const deepseekApiKey = process.env.DEEPSEEK_API_KEY?.trim();
const kimiApiKey = process.env.KIMI_API_KEY?.trim();

if (!deepseekApiKey || !kimiApiKey) {
  throw new Error('DEEPSEEK_API_KEY and KIMI_API_KEY are required');
}

const stack = new XpodTestStack();

try {
  await stack.start('local', {
    transport: 'port',
    open: false,
    apiOpen: false,
    envFile: undefined,
    logLevel: 'error',
    env: { XPOD_ACCEPTANCE_ENDPOINTS_ENABLED: 'true' },
  });
  const account = await setupAccount(stack.baseUrl, `live-ai-${Date.now().toString(36)}`);
  if (!account) throw new Error('Failed to create the live AI acceptance account');

  const session = await loginWithClientCredentials(account);
  const authSession: SolidAuthSession = {
    info: session.info,
    fetch: session.fetch,
  };
  const database = drizzle(authSession, {
    podUrl: account.podUrl,
    schema: {
      aiModel: aiModelResource,
      aiProvider: aiProviderResource,
      credential: credentialResource,
    },
    autoConnect: false,
    resourcePreparation: 'off',
  }) as unknown as SolidDatabase;
  const podStore = createXpodAiConnectionsPodStore({
    database,
    webId: account.webId,
    podUrl: account.podUrl,
  });
  const client = createXpodAiConnectionsClient({
    webId: account.webId,
    podUrl: stack.baseUrl,
    authenticatedFetch: session.fetch,
    invocationFetch: fetch,
  });

  const providers = [
    {
      id: 'deepseek' as const,
      offeringId: 'api-platform',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: deepseekApiKey,
      expectedModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    },
    {
      id: 'kimi' as const,
      offeringId: 'subscription-key',
      baseUrl: 'https://api.kimi.com/coding/v1',
      apiKey: kimiApiKey,
      expectedModels: ['kimi-for-coding', 'kimi-for-coding-highspeed', 'k3', 'k3-256k'],
    },
  ];

  for (const provider of providers) {
    const credential = await podStore.createApiKeyCredential!(provider.id, {
      offeringId: provider.offeringId,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      label: 'Live acceptance',
    });
    const discovery = await client.discoverModels(provider.id, {
      credentialId: credential.id,
      offeringId: provider.offeringId,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
    });
    const modelIds = discovery.models.map((model) => model.id);
    for (const expected of provider.expectedModels) {
      if (!modelIds.includes(expected)) {
        throw new Error(`${provider.id} discovery did not return ${expected}`);
      }
    }
    await podStore.saveDiscoveredModels(provider.id, credential.id, discovery.models);
    await podStore.saveModelSelection(provider.id, provider.expectedModels);
    const quota = await client.quotaFromSecret(provider.id, {
      credentialId: credential.id,
      credentialIri: credential.id,
      authMode: 'apiKey',
      offeringId: provider.offeringId,
      baseUrl: provider.baseUrl,
      secret: { type: 'apiKey', apiKey: provider.apiKey },
    });
    if (quota.status !== 'available' || quota.windows.length === 0) {
      throw new Error(`${provider.id} quota was not available`);
    }
    console.log(JSON.stringify({
      provider: provider.id,
      step: 'xpod-model-discovery',
      count: modelIds.length,
      models: modelIds,
    }));
    console.log(JSON.stringify({
      provider: provider.id,
      step: 'xpod-quota',
      status: quota.status,
      windows: quota.windows.map((window) => window.name),
    }));
  }

  const clientApiKey = `sk-${Buffer.from(`${account.clientId}:${account.clientSecret}`).toString('base64')}`;
  const gatewayHeaders = {
    Authorization: `Bearer ${clientApiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const modelsResponse = await stack.runtimeFetch('/v1/models', { headers: gatewayHeaders });
  const modelsPayload = await readJson(modelsResponse, 'GET /v1/models') as { data?: Array<{ id?: string }> };
  const projectedModelIds = (modelsPayload.data ?? []).flatMap((model) => model.id ? [model.id] : []);
  for (const required of [...providers[0].expectedModels, ...providers[1].expectedModels]) {
    if (!projectedModelIds.includes(required)) {
      throw new Error(`Xpod /v1/models did not project ${required}`);
    }
  }
  console.log(JSON.stringify({ step: 'xpod-models', status: modelsResponse.status, models: projectedModelIds }));

  for (const model of ['deepseek-v4-flash', 'kimi-for-coding']) {
    const chatResponse = await stack.runtimeFetch('/v1/chat/completions', {
      method: 'POST',
      headers: gatewayHeaders,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: XPOD_OK' }],
        max_tokens: 128,
        temperature: 0,
        stream: true,
      }),
    });
    const chatText = await readText(chatResponse, `POST /v1/chat/completions (${model})`);
    assertSemanticSuccess(chatText, `chat/completions ${model}`);
    console.log(JSON.stringify({ step: 'xpod-chat', status: chatResponse.status, model, ok: true }));

    const responsesResponse = await stack.runtimeFetch('/v1/responses', {
      method: 'POST',
      headers: gatewayHeaders,
      body: JSON.stringify({
        model,
        input: 'Reply with exactly: XPOD_OK',
        max_output_tokens: 128,
        stream: true,
      }),
    });
    const responsesText = await readText(responsesResponse, `POST /v1/responses (${model})`);
    assertSemanticSuccess(responsesText, `responses ${model}`);
    console.log(JSON.stringify({ step: 'xpod-responses', status: responsesResponse.status, model, ok: true }));

    const messagesResponse = await stack.runtimeFetch('/v1/messages', {
      method: 'POST',
      headers: {
        ...gatewayHeaders,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: XPOD_OK' }],
        max_tokens: 128,
        temperature: 0,
        stream: true,
      }),
    });
    const messagesText = await readText(messagesResponse, `POST /v1/messages (${model})`);
    assertSemanticSuccess(messagesText, `messages ${model}`);
    console.log(JSON.stringify({ step: 'xpod-messages', status: messagesResponse.status, model, ok: true }));
  }

  await acceptRealClientMatrix({
    baseUrl: stack.baseUrl,
    gatewayKey: clientApiKey,
    model: 'deepseek-v4-flash',
    webId: account.webId,
  });
} finally {
  await stack.stop();
}

async function acceptRealClientMatrix(input: {
  baseUrl: string,
  gatewayKey: string,
  model: string,
  webId: string,
}): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-live-client-matrix-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const toolSentinel = 'XPOD_REAL_CLIENT_TOOL_SENTINEL';
  fs.writeFileSync(path.join(workspace, 'xpod-client-tool-fixture.txt'), `${toolSentinel}\n`);
  const profile = {
    endpoint: input.baseUrl,
    gatewayKey: input.gatewayKey,
    webId: input.webId,
    model: input.model,
  };
  const clients: Array<{
    id: 'codex' | 'claude-code' | 'pi' | 'codebuddy';
    adapter: AiClientConfigAdapter;
    command: string;
    args(prompt: string, tool: boolean): string[];
    env(home: string): NodeJS.ProcessEnv;
  }> = [
    {
      id: 'codex',
      adapter: new CodexConfigAdapter({ homeDir: path.join(root, 'codex') }),
      command: 'codex',
      args: (prompt) => [
        'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
        '--cd', workspace, prompt,
      ],
      env: (home) => clientCommandEnvironment(home, { CODEX_HOME: path.join(home, '.codex') }),
    },
    {
      id: 'claude-code',
      adapter: new ClaudeCodeConfigAdapter({ homeDir: path.join(root, 'claude-code') }),
      command: 'claude',
      args: (prompt) => [
        '--print', '--verbose', '--output-format', 'stream-json', '--model', input.model,
        '--setting-sources', 'user', '--no-session-persistence', '--permission-mode', 'dontAsk', prompt,
      ],
      env: clientCommandEnvironment,
    },
    {
      id: 'pi',
      adapter: new PiConfigAdapter({ homeDir: path.join(root, 'pi') }),
      command: 'pi',
      args: (prompt, tool) => [
        '--provider', 'xpod', '--model', input.model, '--print', '--mode', 'json', '--no-session',
        '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
        ...(tool ? ['--tools', 'read'] : ['--no-tools']), prompt,
      ],
      env: (home) => clientCommandEnvironment(home, { PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent') }),
    },
    {
      id: 'codebuddy',
      adapter: new CodeBuddyConfigAdapter({ homeDir: path.join(root, 'codebuddy') }),
      command: 'codebuddy',
      args: (prompt, tool) => [
        '--print', '--output-format', 'stream-json', '--model', input.model,
        '--setting-sources', 'user', '--no-session-persistence',
        ...(tool ? ['--tools', 'Read'] : []),
        prompt,
      ],
      env: clientCommandEnvironment,
    },
  ];
  const requestedClients = process.env.XPOD_ACCEPTANCE_CLIENTS
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const selectedClients = requestedClients?.length
    ? clients.filter((client) => requestedClients.includes(client.id))
    : clients;
  if (requestedClients?.length && selectedClients.length !== new Set(requestedClients).size) {
    throw new Error(`Unknown XPOD_ACCEPTANCE_CLIENTS value: ${requestedClients.join(',')}`);
  }
  const requestedSteps = new Set(
    (process.env.XPOD_ACCEPTANCE_CLIENT_STEPS ?? 'inference,tool')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if ([...requestedSteps].some((step) => step !== 'inference' && step !== 'tool')) {
    throw new Error(`Unknown XPOD_ACCEPTANCE_CLIENT_STEPS value: ${[...requestedSteps].join(',')}`);
  }

  try {
    for (const client of selectedClients) {
      const home = path.join(root, client.id);
      const plan = await client.adapter.plan(profile);
      await client.adapter.apply(plan);
      const projection = await client.adapter.verify(profile);
      if (!projection.ok) {
        throw new Error(`${client.id} native projection verification failed: ${projection.reason ?? 'unknown'}`);
      }
      try {
        const answerSentinel = `XPOD_REAL_${client.id.toUpperCase().replaceAll('-', '_')}_SENTINEL`;
        if (requestedSteps.has('inference')) {
          const answer = await runCommand(
            client.command,
            client.args(`Answer with exactly this sentinel and no other text: ${answerSentinel}`, false),
            client.env(home),
            workspace,
            180_000,
          );
          assertClientRun(client.id, 'inference', answer, answerSentinel, input.gatewayKey);
        }
        if (requestedSteps.has('tool')) {
          const tool = await runCommand(
            client.command,
            client.args('Read xpod-client-tool-fixture.txt using a file-reading tool and answer with its exact content.', true),
            client.env(home),
            workspace,
            180_000,
          );
          assertClientRun(client.id, 'tool', tool, toolSentinel, input.gatewayKey);
        }
        console.log(JSON.stringify({
          step: 'real-client',
          client: client.id,
          inference: requestedSteps.has('inference'),
          tool: requestedSteps.has('tool'),
          projection: true,
        }));
      } finally {
        await client.adapter.restore(input.webId);
        if ((await client.adapter.inspect()).ownership !== 'unowned') {
          throw new Error(`${client.id} configuration restore was not verified`);
        }
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function clientCommandEnvironment(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? process.env.LANG ?? 'C.UTF-8',
    SHELL: '/bin/zsh',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    ...extra,
  };
}

async function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  const timeout = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  clearTimeout(timeout);
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

function assertClientRun(
  client: string,
  kind: 'inference' | 'tool',
  result: { exitCode: number | null; stdout: string; stderr: string },
  sentinel: string,
  secret: string,
): void {
  const combined = `${result.stdout}\n${result.stderr}`;
  const structuredEvents = combined.split(/\r?\n/u).flatMap((line) => {
    try {
      const event = JSON.parse(line) as unknown;
      return event && typeof event === 'object' && !Array.isArray(event)
        ? [event as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
  const reportedError = structuredEvents.find((event) =>
    event.is_error === true
    || event.type === 'error'
    || event.subtype === 'error_during_execution');
  if (process.env.XPOD_ACCEPTANCE_DEBUG_CLIENT_OUTPUT === 'true') {
    console.log(JSON.stringify({
      step: 'real-client-debug',
      client,
      kind,
      exitCode: result.exitCode,
      output: combined.replaceAll(secret, '[redacted]').slice(-8_000),
    }));
  }
  if (result.exitCode !== 0 || reportedError || !combined.includes(sentinel)) {
    throw new Error(
      `${client} ${kind} failed (exit ${result.exitCode}): ${combined.replaceAll(secret, '[redacted]').slice(-2_000)}`,
    );
  }
  if (combined.includes(secret)) {
    throw new Error(`${client} ${kind} printed the Xpod client credential`);
  }
}

async function readJson(response: Response, operation: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${operation} failed with HTTP ${response.status}: ${text.slice(0, 240)}`);
  return text ? JSON.parse(text) : undefined;
}

async function readText(response: Response, operation: string): Promise<string> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${operation} failed with HTTP ${response.status}: ${text.slice(0, 240)}`);
  return text;
}

function assertSemanticSuccess(text: string, operation: string): void {
  const semanticText = text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .flatMap((line) => {
      try {
        const event = JSON.parse(line.slice(6)) as Record<string, any>;
        return [
          event.choices?.[0]?.delta?.content,
          event.choices?.[0]?.delta?.reasoning_content,
          event.delta,
          event.delta?.text,
          event.delta?.thinking,
          event.text,
        ].filter((value): value is string => typeof value === 'string');
      } catch {
        return [];
      }
    })
    .join('');
  if (!semanticText.includes('XPOD_OK')) {
    throw new Error(`${operation} did not contain the expected semantic response: ${text.slice(0, 800)}`);
  }
}
