#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import { stdin } from 'node:process';

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
}

const TOOL_NAME = 'xpod_smoke_lookup';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
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
                `Call the ${TOOL_NAME} function with {"query":"xpod-ai-connection-smoke"}, then answer with one short sentence.`,
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
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

async function resolveOptions(args: ParsedArgs): Promise<SmokeOptions> {
  const baseUrl = args.baseUrl ?? process.env.AI_CONNECTION_BASE_URL;
  const model = args.model ?? process.env.AI_CONNECTION_MODEL ?? process.env.DEFAULT_MODEL;
  const apiKey = await readApiKey(args);
  if (!baseUrl) throw new Error('Missing --base-url or AI_CONNECTION_BASE_URL');
  if (!model) throw new Error('Missing --model, AI_CONNECTION_MODEL, or DEFAULT_MODEL');
  if (!apiKey) throw new Error('Missing API key. Use --api-key-env NAME or --api-key-stdin.');
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error('--timeout-ms must be a positive number');
  }
  return {
    baseUrl,
    model,
    apiKey,
    expectedWebId: args.expectedWebId ?? process.env.AI_CONNECTION_EXPECTED_WEB_ID,
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
  const envName = args.apiKeyEnv ?? 'AI_CONNECTION_API_KEY';
  return process.env[envName]?.trim();
}

function authHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}

function provenanceFromKey(apiKey: string, expectedWebId: string | undefined): Record<string, unknown> {
  const parts = apiKey.split('_');
  const deployment = parts.length >= 6 && parts[0] === 'xpod' && parts[1] === 'gw' ? parts[3] : 'unknown';
  const keyId = parts.length >= 6 ? parts.slice(4, -1).join('_') : 'unknown';
  return {
    source: 'gateway-api-key',
    deployment,
    keyId,
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
  bun scripts/ai-gateway-codex-smoke.ts --base-url http://localhost:3000 --model gpt-5 --api-key-env AI_CONNECTION_API_KEY
  printf '%s' "$AI_CONNECTION_API_KEY" | bun scripts/ai-gateway-codex-smoke.ts --base-url http://localhost:3000 --model gpt-5 --api-key-stdin

The script never accepts the API key as a CLI value. It prints only non-sensitive provenance evidence.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
