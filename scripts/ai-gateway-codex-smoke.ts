#!/usr/bin/env bun
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { stdin } from 'node:process';

import { AiGatewayService, type GatewayCredentialStore, type StoredGatewayCredential } from '../src/api/ai-gateway/AiGatewayService';
import { AiConnectionsInvocationKeyIssuer } from '../src/api/ai-gateway/auth/AiConnectionsInvocationKeyIssuer';
import { AesInvocationTokenCodec } from '../src/api/ai-gateway/auth/InvocationTokenCodec';
import { SecretCellCredentialVault } from '../src/api/ai-gateway/credentials/SecretCellCredentialVault';
import type { CredentialVault, GatewayPrincipal, ProviderSecret } from '../src/api/ai-gateway/credentials/CredentialVault';
import type { EncryptedCredentialSecret } from '../src/api/ai-gateway/credentials/KeyWrapper';
import { createDefaultProviderRegistry } from '../src/api/ai-gateway/providers/ProviderRegistry';
import type { ProviderRuntimeAdapter, ProviderRuntimeExecuteInput } from '../src/api/ai-gateway/providers/ProviderRuntimeAdapter';
import { parseOpenAiResponsesSse, toResponsesBody } from '../src/api/ai-gateway/providers/ProviderRuntimeAdapter';
import type { ProviderRuntimeRegistry } from '../src/api/ai-gateway/providers/ProviderRuntimeRegistry';
import { InMemorySessionAffinityStore } from '../src/api/ai-gateway/routing/InMemorySessionAffinityStore';
import { ModelRouter } from '../src/api/ai-gateway/routing/ModelRouter';
import type { Authenticator, AuthResult } from '../src/api/auth/Authenticator';
import { ClientCredentialsAuthenticator } from '../src/api/auth/ClientCredentialsAuthenticator';
import { ProviderHttpTransport } from '../src/api/service/provider-http-transport';
import { AiGatewayHandler } from '../src/api/handlers/AiGatewayHandler';
import { AuthMiddleware, type AuthenticatedRequest } from '../src/api/middleware/AuthMiddleware';
import { DeploymentRootKeyProvider, SecretCellVault } from '../src/security/secret-cell';
import { CodexRuntimeProjector } from '../src/api/chatkit/runtime/CodexRuntimeProjector';
import {
  canonicalAcceptanceArtifactHash,
  validateRealCodexProvenance,
  type RealCodexProvenance,
} from './accept-xpod-settings';

interface SmokeOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  expectedWebId?: string;
  timeoutMs: number;
}

interface ParsedArgs {
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKeyStdin?: boolean;
  model?: string;
  expectedWebId?: string;
  timeoutMs?: number;
  fixtureCodexCli?: boolean;
  realCodexCli?: boolean;
  reportDir?: string;
  keepTemp?: boolean;
}

const TOOL_NAME = 'xpod_smoke_lookup';
const CODEX_TOOL_FIXTURE = 'XPOD-CODEX-TOOL-FIXTURE';
const REAL_STREAM_SENTINEL = 'XPOD_REAL_STREAM_SENTINEL';
const REAL_TOOL_SENTINEL = 'XPOD_REAL_TOOL_SENTINEL';
const FIXTURE_WEB_ID = 'https://id.example/alice/profile/card#me';
const FIXTURE_MODEL = 'gpt-5';
const FIXTURE_TOKEN_PATH = '/.fixture/token';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (args.fixtureCodexCli) {
    await runFixtureCodexCliSmoke(args);
    return;
  }
  if (args.realCodexCli) {
    await runRealCodexCliSmoke(args);
    return;
  }
  const options = await resolveOptions(args);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const modelEvidence = await listModels(options, controller.signal);
    const streamEvidence = await runResponsesStream(options, controller.signal);
    const provenanceEvidence = provenanceFromKey(options.apiKey, options.expectedWebId);
    const evidence = {
      ok: true,
      baseUrl: options.baseUrl,
      model: options.model,
      currentWebId: options.expectedWebId ?? provenanceEvidence.webId ?? 'not-provided',
      credentialProvenance: provenanceEvidence,
      modelsEndpoint: modelEvidence,
      streaming: streamEvidence,
    };
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    clearTimeout(timer);
  }
}

async function listModels(options: SmokeOptions, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(new URL('/v1/models', withTrailingSlash(options.baseUrl)), {
    headers: authHeaders(options.apiKey),
    signal,
  });
  const json = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`/v1/models failed: HTTP ${response.status} ${JSON.stringify(json)}`);
  }
  const models = Array.isArray((json as any)?.data) ? (json as any).data : [];
  return {
    status: response.status,
    modelCount: models.length,
    selectedModelVisible: models.some((model: any) => model?.id === options.model),
  };
}

async function runResponsesStream(options: SmokeOptions, signal: AbortSignal): Promise<Record<string, unknown>> {
  const requestId = `smoke-${randomUUID()}`;
  const response = await fetch(new URL('/v1/responses', withTrailingSlash(options.baseUrl)), {
    method: 'POST',
    headers: {
      ...authHeaders(options.apiKey),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model,
      stream: true,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                `Run id: ${requestId}.`,
                `Call the ${TOOL_NAME} function with {"query":"xpod-ai-connections-smoke"}, then answer with one short sentence.`,
              ].join(' '),
            },
          ],
        },
      ],
      tools: [
        {
          type: 'function',
          name: TOOL_NAME,
          description: 'Lookup function used only by the Xpod AI Connection smoke script.',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
            additionalProperties: false,
          },
        },
      ],
    }),
    signal,
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(`/v1/responses stream failed: HTTP ${response.status} ${text.slice(0, 500)}`);
  }

  let sawDone = false;
  let sawTextDelta = false;
  let sawToolCall = false;
  let sawUsage = false;
  let eventCount = 0;
  let outputPreview = '';
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const parsed = parseSseBlock(block);
      if (!parsed) continue;
      eventCount += 1;
      if (parsed === '[DONE]') {
        sawDone = true;
        continue;
      }
      if (parsed.type === 'response.output_text.delta' && typeof parsed.delta === 'string') {
        sawTextDelta = true;
        outputPreview += parsed.delta;
      }
      if (
        parsed.type === 'response.output_item.added' &&
        parsed.item?.type === 'function_call' &&
        parsed.item?.name === TOOL_NAME
      ) {
        sawToolCall = true;
      }
      if (parsed.type === 'response.usage') {
        sawUsage = true;
      }
      if (parsed.error) {
        throw new Error(`terminal SSE error: ${JSON.stringify(parsed.error)}`);
      }
    }
  }

  if (!sawDone) throw new Error('stream ended without [DONE]');
  if (!sawTextDelta) throw new Error('stream did not include response.output_text.delta');
  if (!sawToolCall) throw new Error(`stream did not include ${TOOL_NAME} function_call`);

  return {
    eventCount,
    sawDone,
    sawTextDelta,
    sawToolCall,
    sawUsage,
    outputPreview: outputPreview.trim().slice(0, 160),
  };
}

function parseSseBlock(block: string): any | '[DONE]' | undefined {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('\n')
    .trim();
  if (!data) return undefined;
  if (data === '[DONE]') return '[DONE]';
  return JSON.parse(data);
}

function parseArgs(argv: string[]): ParsedArgs & { help?: boolean } {
  const parsed: ParsedArgs & { help?: boolean } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--base-url') {
      parsed.baseUrl = requireValue(argv, ++index, arg);
    } else if (arg === '--api-key-env') {
      parsed.apiKeyEnv = requireValue(argv, ++index, arg);
    } else if (arg === '--api-key-stdin') {
      parsed.apiKeyStdin = true;
    } else if (arg === '--model') {
      parsed.model = requireValue(argv, ++index, arg);
    } else if (arg === '--expected-web-id') {
      parsed.expectedWebId = requireValue(argv, ++index, arg);
    } else if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(requireValue(argv, ++index, arg));
    } else if (arg === '--fixture-codex-cli') {
      parsed.fixtureCodexCli = true;
    } else if (arg === '--real-codex-cli') {
      parsed.realCodexCli = true;
    } else if (arg === '--report-dir') {
      parsed.reportDir = requireValue(argv, ++index, arg);
    } else if (arg === '--keep-temp') {
      parsed.keepTemp = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

async function resolveOptions(args: ParsedArgs): Promise<SmokeOptions> {
  const baseUrl = args.baseUrl ?? process.env.AI_CONNECTIONS_BASE_URL;
  const model = args.model ?? process.env.AI_CONNECTIONS_MODEL ?? process.env.DEFAULT_MODEL;
  const apiKey = await readApiKey(args);
  if (!baseUrl) throw new Error('Missing --base-url or AI_CONNECTIONS_BASE_URL');
  if (!model) throw new Error('Missing --model, AI_CONNECTIONS_MODEL, or DEFAULT_MODEL');
  if (!apiKey) throw new Error('Missing API key. Use --api-key-env NAME or --api-key-stdin.');
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error('--timeout-ms must be a positive number');
  }
  return {
    baseUrl,
    model,
    apiKey,
    expectedWebId: args.expectedWebId ?? process.env.AI_CONNECTIONS_EXPECTED_WEB_ID,
    timeoutMs: args.timeoutMs ?? 120_000,
  };
}

async function readApiKey(args: ParsedArgs): Promise<string | undefined> {
  if (args.apiKeyStdin) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  const envName = args.apiKeyEnv ?? 'AI_CONNECTIONS_API_KEY';
  return process.env[envName]?.trim();
}

function authHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}

function provenanceFromKey(apiKey: string, expectedWebId: string | undefined): Record<string, unknown> {
  if (apiKey.startsWith('xpod_inv_v1.')) {
    return {
      source: 'invocation-token',
      deployment: 'unknown',
      keyId: apiKey.split('.')[1] ?? 'unknown',
      webId: expectedWebId,
      secretMaterialPrinted: false,
    };
  }
  if (apiKey.startsWith('sk-')) {
    const decoded = Buffer.from(apiKey.slice(3), 'base64').toString('utf8');
    const clientId = decoded.split(':')[0]?.trim() || 'unknown';
    return {
      source: 'client-credentials',
      deployment: 'unknown',
      keyId: clientId,
      webId: expectedWebId,
      secretMaterialPrinted: false,
    };
  }
  return {
    source: 'unknown',
    deployment: 'unknown',
    keyId: 'unknown',
    webId: expectedWebId,
    secretMaterialPrinted: false,
  };
}

function withTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function printUsage(): void {
  console.log(`Usage:
  bun scripts/ai-gateway-codex-smoke.ts --base-url http://localhost:3000 --model gpt-5 --api-key-env AI_CONNECTIONS_API_KEY
  printf '%s' "$AI_CONNECTIONS_API_KEY" | bun scripts/ai-gateway-codex-smoke.ts --base-url http://localhost:3000 --model gpt-5 --api-key-stdin
  printf '%s' "$XPOD_ACCEPTANCE_GATEWAY_KEY" | bun scripts/ai-gateway-codex-smoke.ts --real-codex-cli --base-url http://localhost:3000 --model gpt-5 --api-key-stdin
  bun scripts/ai-gateway-codex-smoke.ts --fixture-codex-cli

The real Codex mode requires the Xpod runtime to have XPOD_ACCEPTANCE_ENDPOINTS_ENABLED=true
and the Gateway key to include acceptance:read plus normal protocol scopes. The script never
accepts the API key as a CLI value. It prints only non-sensitive provenance evidence.`);
}

async function runRealCodexCliSmoke(args: ParsedArgs): Promise<void> {
  const options = await resolveOptions(args);
  const timeoutMs = args.timeoutMs ?? 180_000;
  const reportRoot = path.resolve(args.reportDir ?? '.test-data/ai-gateway-codex-real');
  fs.mkdirSync(reportRoot, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-real-codex-'));
  const codexHome = path.join(tempRoot, 'codex-home');
  const workspace = path.join(tempRoot, 'workspace');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'xpod-real-tool-fixture.txt'), REAL_TOOL_SENTINEL);
  const backup = snapshotCodexHome(codexHome);
  const projector = new CodexRuntimeProjector();
  const codexBaseUrl = new URL('/v1', withTrailingSlash(options.baseUrl)).toString().replace(/\/$/u, '');
  const startedAt = new Date().toISOString();
  const initialProvenance = await fetchRealCodexProvenance({
    baseUrl: options.baseUrl,
    model: options.model,
    gatewayKey: options.apiKey,
    signal: AbortSignal.timeout(Math.min(timeoutMs, 30_000)),
  });
  let restoreVerified = false;
  const runs: CodexRunEvidence[] = [];

  try {
    projector.project({
      codexHome,
      baseUrl: codexBaseUrl,
      apiKey: options.apiKey,
      wireApi: 'responses',
      model: options.model,
    });
    verifyProjectedCodexHome(codexHome, { baseUrl: codexBaseUrl, apiKey: options.apiKey });
    runs.push(await runCodexExec({
      codexHome,
      workspace,
      prompt: `Answer with exactly this sentinel and no other text: ${REAL_STREAM_SENTINEL}`,
      timeoutMs,
    }));
    runs.push(await runCodexExec({
      codexHome,
      workspace,
      prompt: 'Read xpod-real-tool-fixture.txt using tools and answer with its exact content.',
      timeoutMs,
    }));
  } finally {
    restoreCodexHome(codexHome, backup);
    restoreVerified = !fs.existsSync(path.join(codexHome, 'config.toml')) && !fs.existsSync(path.join(codexHome, 'auth.json'));
    if (!args.keepTemp) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  const storedRuns = runs.map(({ stdoutJsonl, stderrPreview, ...run }) => ({
    ...run,
    stderrPreview: sanitize(stderrPreview),
    eventTypes: stdoutJsonl.map((event) => String(event.type ?? 'unknown')),
  }));
  const command = ['codex', 'exec', '--json', '--cd', '<workspace>', '<redacted-prompt>'];
  const provenance = validateRealCodexProvenance({
    baseUrl: options.baseUrl,
    model: options.model,
    gatewayKey: options.apiKey,
    provenance: {
      ...initialProvenance,
      commandHash: `sha256:${canonicalAcceptanceArtifactHash(command)}`,
      resultHash: `sha256:${canonicalAcceptanceArtifactHash(storedRuns)}`,
    },
  });
  const report = {
    schema: 'xpod.acceptance.evidence.v1',
    generatedAt: startedAt,
    requirementId: 'real-codex',
    command,
    provenance: {
      ...provenance,
      model: options.model,
      gatewayKeySource: args.apiKeyStdin ? 'stdin' : `env:${args.apiKeyEnv ?? 'AI_CONNECTIONS_API_KEY'}`,
      artifactHash: 'sha256:pending',
    },
    redaction: {
      checked: true,
      secretMaterialFound: false,
    },
    codexVersion: await codexVersion(),
    restoreVerified,
    runs: storedRuns,
  };
  assertRealCodexReport(report, options.apiKey);
  const reportWithHash = withArtifactHash(report);
  const reportPath = path.join(reportRoot, `real-codex-${Date.now()}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(reportWithHash, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: true,
    reportPath,
    generatedAt: reportWithHash.generatedAt,
    provenance: reportWithHash.provenance,
    restoreVerified,
    runs: reportWithHash.runs.map((run: any) => ({
      exitCode: run.exitCode,
      sawTurnCompleted: run.sawTurnCompleted,
      sawCommandExecution: run.sawCommandExecution,
      finalMessage: run.finalMessage,
    })),
  }, null, 2));
}

async function fetchRealCodexProvenance(input: {
  baseUrl: string;
  model: string;
  gatewayKey: string;
  signal: AbortSignal;
}): Promise<Omit<RealCodexProvenance, 'commandHash' | 'resultHash'>> {
  const url = new URL('/v1/xpod/acceptance/provenance', withTrailingSlash(input.baseUrl));
  url.searchParams.set('model', input.model);
  const response = await fetch(url, {
    headers: {
      ...authHeaders(input.gatewayKey),
    },
    signal: input.signal,
  });
  const json = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`Acceptance provenance lookup failed: HTTP ${response.status} ${JSON.stringify(json)}`);
  }
  const provenance = json as Omit<RealCodexProvenance, 'commandHash' | 'resultHash'>;
  const expectedFingerprint = `sha256:${canonicalAcceptanceArtifactHash(input.gatewayKey)}`;
  if (provenance.gatewayKeyFingerprint !== expectedFingerprint) {
    throw new Error('Acceptance provenance Gateway key fingerprint mismatch');
  }
  return provenance;
}

async function runFixtureCodexCliSmoke(args: ParsedArgs): Promise<void> {
  const timeoutMs = args.timeoutMs ?? 120_000;
  const reportRoot = path.resolve(args.reportDir ?? '.test-data/ai-gateway-codex');
  fs.mkdirSync(reportRoot, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-ai-connections-codex-'));
  const codexHome = path.join(tempRoot, 'codex-home');
  const workspace = path.join(tempRoot, 'workspace');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const fixturePath = path.join(workspace, 'fixture.txt');
  fs.writeFileSync(fixturePath, CODEX_TOOL_FIXTURE);

  const upstream = await startDeterministicResponsesUpstream({ fixturePath, workspace });
  const xpod = await startFixtureXpodGateway({ upstreamBaseUrl: upstream.baseUrl });
  const projector = new CodexRuntimeProjector();
  const configBefore = 'original = true\n';
  const authBefore = JSON.stringify({ OPENAI_API_KEY: 'original' }, null, 2);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), configBefore);
  fs.writeFileSync(path.join(codexHome, 'auth.json'), authBefore);
  const backup = snapshotCodexHome(codexHome);
  const appliedConfig = {
    codexHome,
    baseUrl: new URL('/v1', xpod.baseUrl).toString().replace(/\/$/u, ''),
    apiKey: xpod.gatewayKeyPlaintext,
    wireApi: 'responses' as const,
    model: FIXTURE_MODEL,
  };

  const runs: CodexRunEvidence[] = [];
  let restoreVerified = false;
  try {
    projector.project(appliedConfig);
    verifyProjectedCodexHome(codexHome, {
      baseUrl: appliedConfig.baseUrl,
      apiKey: appliedConfig.apiKey,
    });

    runs.push(await runCodexExec({
      codexHome,
      workspace,
      prompt: 'Answer with exactly: XPOD STREAM OK',
      timeoutMs,
    }));
    runs.push(await runCodexExec({
      codexHome,
      workspace,
      prompt: 'Read fixture.txt using tools and answer with its exact content.',
      timeoutMs,
    }));
  } finally {
    restoreCodexHome(codexHome, backup);
    restoreVerified = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8') === configBefore
      && fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8') === authBefore;
    await xpod.stop();
    await upstream.stop();
    if (!args.keepTemp) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  const report = buildFixtureReport({
    codexVersion: await codexVersion(),
    reportRoot,
    tempRoot: args.keepTemp ? tempRoot : undefined,
    xpod,
    upstream,
    runs,
    restoreVerified,
  });
  const reportPath = path.join(reportRoot, `codex-cli-${Date.now()}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  assertFixtureReport(report);
  console.log(JSON.stringify({
    ok: true,
    reportPath,
    codexVersion: report.codexVersion,
    xpodResponses: report.xpod.responses.length,
    upstreamRequests: report.upstream.requestCount,
    codexRuns: report.codex.runs.map((run) => ({
      exitCode: run.exitCode,
      sawTurnCompleted: run.sawTurnCompleted,
      sawCommandExecution: run.sawCommandExecution,
      finalMessage: run.finalMessage,
    })),
    provenance: report.provenance,
    restoreVerified: report.codex.restoreVerified,
  }, null, 2));
}

interface DeterministicUpstream {
  baseUrl: string;
  requests: Array<{ body: unknown; authorization: string | undefined }>;
  eventScripts: Array<{ responseId: string; eventTypes: string[]; textDeltaCount: number; toolCall: boolean }>;
  stop(): Promise<void>;
}

async function startDeterministicResponsesUpstream(options: {
  fixturePath: string;
  workspace: string;
}): Promise<DeterministicUpstream> {
  const requests: DeterministicUpstream['requests'] = [];
  const eventScripts: DeterministicUpstream['eventScripts'] = [];
  let requestCount = 0;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = parseJson(Buffer.concat(chunks).toString('utf8'));
      requests.push({
        body,
        authorization: request.headers.authorization,
      });
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404);
        response.end('not found');
        return;
      }

      requestCount += 1;
      if (requestCount === 1) {
        const events = textResponseEvents('resp_stream', ['XPOD ', 'STREAM ', 'OK']);
        eventScripts.push({ responseId: 'resp_stream', eventTypes: events.map((event) => event.type), textDeltaCount: 3, toolCall: false });
        writeSse(response, events);
        return;
      }
      if (requestCount === 2) {
        const args = JSON.stringify({
          cmd: `cat ${JSON.stringify(options.fixturePath)}`,
          workdir: options.workspace,
          yield_time_ms: 10_000,
          max_output_tokens: 2_000,
        });
        const splitAt = Math.ceil(args.length / 2);
        const events = [
          { type: 'response.created', response: { id: 'resp_tool' } },
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: '' },
          },
          {
            type: 'response.function_call_arguments.delta',
            item_id: 'fc_1',
            output_index: 0,
            delta: args.slice(0, splitAt),
          },
          {
            type: 'response.function_call_arguments.delta',
            item_id: 'fc_1',
            output_index: 0,
            delta: args.slice(splitAt),
          },
          {
            type: 'response.function_call_arguments.done',
            item_id: 'fc_1',
            output_index: 0,
            name: 'exec_command',
            arguments: args,
          },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: args },
          },
          completedEvent('resp_tool'),
        ];
        eventScripts.push({ responseId: 'resp_tool', eventTypes: events.map((event) => event.type), textDeltaCount: 0, toolCall: true });
        writeSse(response, events);
        return;
      }

      const events = textResponseEvents('resp_tool_final', [CODEX_TOOL_FIXTURE]);
      eventScripts.push({ responseId: 'resp_tool_final', eventTypes: events.map((event) => event.type), textDeltaCount: 1, toolCall: false });
      writeSse(response, events);
    });
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to start upstream fixture server');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    eventScripts,
    stop: () => close(server),
  };
}

function textResponseEvents(responseId: string, deltas: string[]): Record<string, unknown>[] {
  const text = deltas.join('');
  return [
    { type: 'response.created', response: { id: responseId } },
    { type: 'response.output_item.added', output_index: 0, item: { id: `${responseId}_msg`, type: 'message', role: 'assistant', content: [] } },
    { type: 'response.content_part.added', item_id: `${responseId}_msg`, output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
    ...deltas.map((delta) => ({
      type: 'response.output_text.delta',
      item_id: `${responseId}_msg`,
      output_index: 0,
      content_index: 0,
      delta,
    })),
    { type: 'response.content_part.done', item_id: `${responseId}_msg`, output_index: 0, content_index: 0, part: { type: 'output_text', text } },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { id: `${responseId}_msg`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
    },
    completedEvent(responseId),
  ];
}

function completedEvent(responseId: string): Record<string, unknown> {
  return {
    type: 'response.completed',
    response: {
      id: responseId,
      status: 'completed',
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
    },
  };
}

function writeSse(response: ServerResponse, events: Record<string, unknown>[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.write('data: [DONE]\n\n');
  response.end();
}

interface FixtureXpodGateway {
  baseUrl: string;
  gatewayKeyPlaintext: string;
  gatewayKeyId: string;
  xpodResponses: Array<{
    path: string;
    eventTypes: string[];
    textDeltaCount: number;
    toolCall: boolean;
    rawUndefinedBlocks: string[];
    eventPreview: Array<Record<string, unknown> | '[DONE]'>;
  }>;
  credentialStoreCalls: Array<{ webId: string; deployment: string }>;
  vaultOpenCalls: Array<{ webId: string; credentialIri: string; provider: string }>;
  gatewayTouches: string[];
  stop(): Promise<void>;
}

async function startFixtureXpodGateway(options: { upstreamBaseUrl: string }): Promise<FixtureXpodGateway> {
  const deployment = 'local' as const;
  const clientId = 'codex_smoke_client';
  const clientSecret = randomBytes(24).toString('base64url');

  const secretCell = new SecretCellCredentialVault({
    vault: new SecretCellVault({
      rootKeys: new DeploymentRootKeyProvider({
        activeKeyId: 'codex-smoke-root',
        keys: {
          'codex-smoke-root': randomBytes(32),
        },
      }),
    }),
  });
  const encryptedSecret = await secretCell.seal(
    { webId: FIXTURE_WEB_ID },
    'https://pod.example/alice/settings/ai-credentials.ttl#openai',
    'openai',
    { apiKey: 'fixture-upstream-token' },
  );
  const countingVault = new CountingCredentialVault(secretCell);
  const credentialCalls: Array<{ webId: string; deployment: string }> = [];
  const credential: StoredGatewayCredential = {
    id: 'cred_openai_codex_smoke',
    credentialIri: 'https://pod.example/alice/settings/ai-credentials.ttl#openai',
    provider: 'openai',
    authMode: 'apiKey',
    enabled: true,
    priority: 100,
    models: [FIXTURE_MODEL],
    defaultModel: FIXTURE_MODEL,
    health: 'healthy',
    quota: { status: 'available' },
    encryptedSecret,
    runtimeCredential: { baseUrl: options.upstreamBaseUrl },
    version: 1,
  };
  const store: GatewayCredentialStore = {
    listCredentials: async({ webId, deployment }) => {
      credentialCalls.push({ webId, deployment });
      return webId === FIXTURE_WEB_ID ? [credential] : [];
    },
    recordSuccess: async() => {},
    recordFailure: async() => {},
  };
  const registry = createDefaultProviderRegistry();
  const service = new AiGatewayService({
    deployment,
    registry,
    router: new ModelRouter({
      registry,
      affinityStore: new InMemorySessionAffinityStore({ secret: randomBytes(32).toString('base64url') }),
      credentials: store.listCredentials.bind(store),
    }),
    credentials: store,
    vault: countingVault,
    runtimes: {
      get: () => new FixtureOpenAiResponsesAdapter(options.upstreamBaseUrl),
    } as unknown as ProviderRuntimeRegistry,
  });
  const handler = new AiGatewayHandler({ service });
  const xpodResponses: FixtureXpodGateway['xpodResponses'] = [];
  let auth: AuthMiddleware | undefined;
  const server = http.createServer(async(request: AuthenticatedRequest, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'POST' && url.pathname === FIXTURE_TOKEN_PATH) {
      request.resume();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        access_token: 'fixture-access-token',
        token_type: 'Bearer',
        expires_in: 3600,
        webid: FIXTURE_WEB_ID,
      }));
      return;
    }
    if (url.pathname === '/v1/responses') {
      captureResponseSse(response, url.pathname, xpodResponses);
    }
    if (!auth || !await auth.process(request, response)) {
      if (!auth) {
        response.writeHead(503);
        response.end('fixture auth not initialised');
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/responses') {
      await handler.handleInference(request, response, 'responses');
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      await handler.handleModels(request, response);
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to start Xpod fixture server');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const invocationKeyIssuer = new AiConnectionsInvocationKeyIssuer({
    codec: new AesInvocationTokenCodec({
      active: { kid: 'codex-smoke-inv', secret: randomBytes(32).toString('hex') },
    }),
    deployment,
    baseUrl,
  });
  const invocation = await invocationKeyIssuer.issue({
    auth: {
      type: 'solid',
      webId: FIXTURE_WEB_ID,
      viaApiKey: true,
      clientId,
      clientSecret,
    },
  });
  const authenticator = new TouchTrackingAuthenticator(
    new ClientCredentialsAuthenticator({ tokenEndpoint: `${baseUrl}${FIXTURE_TOKEN_PATH}` }),
  );
  auth = new AuthMiddleware({ authenticator });
  return {
    baseUrl,
    gatewayKeyPlaintext: invocation.apiKey,
    gatewayKeyId: clientId,
    xpodResponses,
    credentialStoreCalls: credentialCalls,
    vaultOpenCalls: countingVault.openCalls,
    gatewayTouches: authenticator.touches,
    stop: () => close(server),
  };
}

class FixtureOpenAiResponsesAdapter implements ProviderRuntimeAdapter {
  public readonly provider = 'openai';
  private readonly transport = new ProviderHttpTransport();

  public constructor(private readonly upstreamBaseUrl: string) {}

  public async *execute(input: ProviderRuntimeExecuteInput) {
    yield* parseOpenAiResponsesSse(this.transport.postSse({
      url: `${this.upstreamBaseUrl}/responses`,
      apiKey: input.apiKey,
      body: toResponsesBody(input.request),
      proxy: input.credential?.proxy,
      signal: input.signal,
    }), input.apiKey);
  }
}

class CountingCredentialVault implements CredentialVault {
  public readonly openCalls: Array<{ webId: string; credentialIri: string; provider: string }> = [];

  public constructor(private readonly inner: CredentialVault) {}

  public async seal(principal: GatewayPrincipal, credentialIri: string, provider: string, secret: ProviderSecret): Promise<EncryptedCredentialSecret> {
    return await this.inner.seal(principal, credentialIri, provider, secret);
  }

  public async open(principal: GatewayPrincipal, credentialIri: string, provider: string, encrypted: EncryptedCredentialSecret): Promise<ProviderSecret> {
    this.openCalls.push({ webId: principal.webId, credentialIri, provider });
    return await this.inner.open(principal, credentialIri, provider, encrypted);
  }

  public needsRewrap(encrypted: EncryptedCredentialSecret): boolean {
    return this.inner.needsRewrap?.(encrypted) ?? false;
  }

  public async rewrap(principal: { webId: string }, encrypted: EncryptedCredentialSecret): Promise<EncryptedCredentialSecret> {
    if (!this.inner.rewrap) throw new Error('inner vault does not support rewrap');
    return await this.inner.rewrap(principal, encrypted);
  }
}

class TouchTrackingAuthenticator implements Authenticator {
  public readonly touches: string[] = [];

  public constructor(private readonly inner: Authenticator) {}

  public canAuthenticate(request: IncomingMessage): boolean {
    return this.inner.canAuthenticate(request);
  }

  public async authenticate(request: IncomingMessage): Promise<AuthResult> {
    const result = await this.inner.authenticate(request);
    if (result.success && result.context?.type === 'solid') {
      this.touches.push(result.context.clientId ?? result.context.webId);
    }
    return result;
  }
}

function captureResponseSse(
  response: ServerResponse,
  routePath: string,
  captures: FixtureXpodGateway['xpodResponses'],
): void {
  const originalWrite = response.write.bind(response);
  let body = '';
  response.write = ((chunk: unknown, ...args: unknown[]) => {
    body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    return originalWrite(chunk as any, ...(args as []));
  }) as typeof response.write;
  response.once('finish', () => {
    const events = parseSseBody(body);
    captures.push({
      path: routePath,
      eventTypes: events.filter((event) => event !== '[DONE]').map((event) => String((event as any).type)),
      textDeltaCount: events.filter((event) => (event as any).type === 'response.output_text.delta').length,
      toolCall: events.some((event) => (event as any).type === 'response.output_item.added' && (event as any).item?.type === 'function_call'),
      rawUndefinedBlocks: rawUndefinedSseBlocks(body),
      eventPreview: events.slice(0, 12),
    });
  });
}

function rawUndefinedSseBlocks(body: string): string[] {
  return body
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .filter((block) => {
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (!data || data === '[DONE]') return false;
      const parsed = parseJson(data);
      return !(parsed as any).type;
    })
    .map((block) => sanitize(block).slice(0, 1_000));
}

function parseSseBody(body: string): Array<Record<string, unknown> | '[DONE]'> {
  return body
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (data === '[DONE]') return '[DONE]';
      return parseJson(data) as Record<string, unknown>;
    });
}

interface CodexRunEvidence {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutJsonl: Array<Record<string, unknown>>;
  stderrPreview: string;
  finalMessage?: string;
  sawTurnCompleted: boolean;
  sawCommandExecution: boolean;
  commandOutputPreview?: string;
}

type StoredCodexRunEvidence = Omit<CodexRunEvidence, 'stdoutJsonl' | 'stderrPreview'> & {
  eventTypes: string[];
};

async function runCodexExec(options: {
  codexHome: string;
  workspace: string;
  prompt: string;
  timeoutMs: number;
}): Promise<CodexRunEvidence> {
  const result = await spawnCommand('codex', [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '--cd',
    options.workspace,
    options.prompt,
  ], codexCommandEnvironment(options.codexHome), options.timeoutMs);
  const stdoutJsonl = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseJson(line) as Record<string, unknown>);
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    stdoutJsonl,
    stderrPreview: sanitize(result.stderr).slice(0, 2_000),
    finalMessage: lastAgentMessage(stdoutJsonl),
    sawTurnCompleted: stdoutJsonl.some((event) => event.type === 'turn.completed'),
    sawCommandExecution: stdoutJsonl.some((event) => (event as any).item?.type === 'command_execution'),
    commandOutputPreview: sanitize(String(
      stdoutJsonl.find((event) => (event as any).item?.type === 'command_execution' && (event as any).item?.status === 'completed')
        ? (stdoutJsonl.find((event) => (event as any).item?.type === 'command_execution' && (event as any).item?.status === 'completed') as any).item.aggregated_output
        : '',
    )),
  };
}

async function spawnCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

async function codexVersion(): Promise<string> {
  const result = await spawnCommand('codex', ['--version'], codexCommandEnvironment(os.tmpdir()), 10_000);
  return result.stdout.trim() || result.stderr.trim() || 'unknown';
}

function codexCommandEnvironment(codexHome: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: codexHome,
    CODEX_HOME: codexHome,
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? process.env.LANG ?? 'C.UTF-8',
    SHELL: '/bin/zsh',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
}

function lastAgentMessage(events: Array<Record<string, unknown>>): string | undefined {
  for (const event of [...events].reverse()) {
    const item = (event as any).item;
    if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
      return item.text;
    }
  }
  return undefined;
}

function snapshotCodexHome(codexHome: string): Record<string, string | undefined> {
  return {
    config: readOptional(path.join(codexHome, 'config.toml')),
    auth: readOptional(path.join(codexHome, 'auth.json')),
  };
}

function restoreCodexHome(codexHome: string, snapshot: Record<string, string | undefined>): void {
  restoreFile(path.join(codexHome, 'config.toml'), snapshot.config);
  restoreFile(path.join(codexHome, 'auth.json'), snapshot.auth);
}

function restoreFile(filePath: string, contents: string | undefined): void {
  if (contents === undefined) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  fs.writeFileSync(filePath, contents);
}

function readOptional(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function verifyProjectedCodexHome(codexHome: string, expected: { baseUrl: string; apiKey: string }): void {
  const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  const auth = JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'));
  if (!config.includes(`base_url = ${JSON.stringify(expected.baseUrl)}`)) {
    throw new Error('Codex config did not receive Xpod AI Connection base URL');
  }
  if (!config.includes('wire_api = "responses"')) {
    throw new Error('Codex config did not select Responses wire API');
  }
  if (auth.OPENAI_API_KEY !== expected.apiKey) {
    throw new Error('Codex auth did not receive Gateway API key');
  }
}

interface FixtureReport {
  ok: true;
  codexVersion: string;
  reportRoot: string;
  tempRoot?: string;
  provenance: {
    webId: string;
    gatewayKeyId: string;
    credentialIri: string;
    credentialProvider: string;
    credentialSource: 'pod-secret-cell';
    secretMaterialPrinted: false;
  };
  codex: {
    restoreVerified: boolean;
    runs: StoredCodexRunEvidence[];
  };
  xpod: {
    baseUrl: string;
    responses: FixtureXpodGateway['xpodResponses'];
    credentialStoreCalls: FixtureXpodGateway['credentialStoreCalls'];
    vaultOpenCalls: FixtureXpodGateway['vaultOpenCalls'];
    gatewayTouches: string[];
  };
  upstream: {
    requestCount: number;
    eventScripts: DeterministicUpstream['eventScripts'];
    bearerHeaders: string[];
  };
}

function buildFixtureReport(input: {
  codexVersion: string;
  reportRoot: string;
  tempRoot?: string;
  xpod: FixtureXpodGateway;
  upstream: DeterministicUpstream;
  runs: CodexRunEvidence[];
  restoreVerified: boolean;
}): FixtureReport {
  return {
    ok: true,
    codexVersion: input.codexVersion,
    reportRoot: input.reportRoot,
    tempRoot: input.tempRoot,
    provenance: {
      webId: FIXTURE_WEB_ID,
      gatewayKeyId: input.xpod.gatewayKeyId,
      credentialIri: input.xpod.vaultOpenCalls[0]?.credentialIri ?? 'missing',
      credentialProvider: input.xpod.vaultOpenCalls[0]?.provider ?? 'missing',
      credentialSource: 'pod-secret-cell',
      secretMaterialPrinted: false,
    },
    codex: {
      restoreVerified: input.restoreVerified,
      runs: input.runs.map(({ stdoutJsonl, stderrPreview: _stderrPreview, ...run }) => ({
        ...run,
        eventTypes: stdoutJsonl.map((event) => String(event.type ?? 'unknown')),
      })),
    },
    xpod: {
      baseUrl: input.xpod.baseUrl,
      responses: input.xpod.xpodResponses,
      credentialStoreCalls: input.xpod.credentialStoreCalls,
      vaultOpenCalls: input.xpod.vaultOpenCalls,
      gatewayTouches: input.xpod.gatewayTouches,
    },
    upstream: {
      requestCount: input.upstream.requests.length,
      eventScripts: input.upstream.eventScripts,
      bearerHeaders: input.upstream.requests
        .map((request) => request.authorization ? 'Bearer <redacted>' : 'missing'),
    },
  };
}

function assertFixtureReport(report: FixtureReport): void {
  if (!report.codexVersion.includes('codex-cli 0.144.5')) {
    throw new Error(`Expected codex-cli 0.144.5, got ${report.codexVersion}`);
  }
  if (report.codex.runs.length !== 2 || report.codex.runs.some((run) => run.exitCode !== 0 || !run.sawTurnCompleted)) {
    throw new Error(`Expected two successful codex exec runs: ${JSON.stringify(report.codex.runs.map((run) => ({
      exitCode: run.exitCode,
      signal: run.signal,
      sawTurnCompleted: run.sawTurnCompleted,
      finalMessage: run.finalMessage,
    })))}`);
  }
  if (report.codex.runs[0]?.finalMessage !== 'XPOD STREAM OK') {
    throw new Error('Codex stream run did not return expected final message');
  }
  if (!report.codex.runs[1]?.sawCommandExecution || report.codex.runs[1]?.finalMessage !== CODEX_TOOL_FIXTURE) {
    throw new Error('Codex tool run did not execute a real tool call and return fixture content');
  }
  if (!report.codex.restoreVerified) {
    throw new Error('Codex HOME restore was not verified');
  }
  if (!report.xpod.responses.some((response) => response.textDeltaCount >= 3)) {
    throw new Error('Xpod did not stream multiple Responses text deltas');
  }
  if (!report.xpod.responses.some((response) => response.toolCall)) {
    throw new Error('Xpod did not stream a Responses function_call event');
  }
  if (!report.xpod.credentialStoreCalls.every((call) => call.webId === FIXTURE_WEB_ID)) {
    throw new Error('Credential store was not scoped to the current WebID');
  }
  if (report.xpod.vaultOpenCalls.length < 3 || !report.xpod.vaultOpenCalls.every((call) => call.webId === FIXTURE_WEB_ID)) {
    throw new Error('SecretCell credential open provenance is incomplete');
  }
  if (report.xpod.gatewayTouches.length < 3) {
    throw new Error('Gateway API key authenticator did not touch successful uses');
  }
  if (report.upstream.requestCount < 3 || report.upstream.bearerHeaders.some((header) => header !== 'Bearer <redacted>')) {
    throw new Error('Upstream fixture did not receive provider-token authenticated requests');
  }
}

function assertRealCodexReport(report: any, apiKey: string): void {
  validateRealCodexProvenance({
    baseUrl: report.provenance?.xpodBaseUrl,
    model: report.provenance?.model,
    gatewayKey: apiKey,
    provenance: report.provenance,
  });
  if (!report.restoreVerified) {
    throw new Error('Real Codex HOME restore was not verified');
  }
  if (!Array.isArray(report.runs) || report.runs.length !== 2) {
    throw new Error('Real Codex acceptance requires two runs');
  }
  if (report.runs.some((run: any) => run.exitCode !== 0 || !run.sawTurnCompleted)) {
    throw new Error(`Real Codex run failed: ${JSON.stringify(report.runs.map((run: any) => ({
      exitCode: run.exitCode,
      signal: run.signal,
      sawTurnCompleted: run.sawTurnCompleted,
      finalMessage: run.finalMessage,
    })))}`);
  }
  if (String(report.runs[0]?.finalMessage ?? '').trim() !== REAL_STREAM_SENTINEL) {
    throw new Error('Real Codex stream run did not return the sentinel');
  }
  if (!report.runs[1]?.sawCommandExecution) {
    throw new Error('Real Codex tool run did not execute a tool call');
  }
  if (String(report.runs[1]?.finalMessage ?? '').trim() !== REAL_TOOL_SENTINEL) {
    throw new Error('Real Codex tool run did not return the sentinel');
  }
  const serialized = JSON.stringify(report);
  if (serialized.includes(apiKey) || /xpod_gw_v1_[A-Za-z0-9._-]+/.test(serialized) || /sk-[A-Za-z0-9._-]+/.test(serialized)) {
    throw new Error('Real Codex report contains secret material');
  }
}

function withArtifactHash<T extends { provenance: { artifactHash: string } }>(report: T): T {
  return {
    ...report,
    provenance: {
      ...report.provenance,
      artifactHash: `sha256:${canonicalAcceptanceArtifactHash(report)}`,
    },
  };
}

function sanitize(value: string): string {
  return value
    .replaceAll(/xpod_gw_v1_[A-Za-z]+_[A-Za-z0-9_-]+_[A-Za-z0-9-]+/gu, 'xpod_gw_v1_<redacted>')
    .replaceAll(/sk-[A-Za-z0-9+/=._-]+/gu, 'sk-<redacted>')
    .replaceAll(/fixture-upstream-token/gu, '<redacted-provider-token>');
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

async function listen(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
