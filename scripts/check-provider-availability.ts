/**
 * Independent third-party upstream availability monitor.
 *
 * This is deliberately NOT an Xpod, Pod, candidate or RC acceptance check. It
 * talks directly to a configured OpenAI-compatible provider: one GET /models,
 * then exactly one POST /chat/completions whose reply must equal a fresh nonce.
 * A missing credential is reported as unconfigured, never as a pass.
 *
 * The report is an allowlisted projection. Response bodies, headers, keys,
 * environment dumps, raw error messages, reasoning content and user data are
 * never included.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PROVIDER_LABELS,
  defaultOfferingFor,
  offeringBaseUrl,
  providerOfferings,
} from '@undefineds.co/ai-connections-runtime/provider-catalog';
import {
  CHAT_ACCEPTANCE_MAX_OUTPUT_TOKENS,
  chatCompletionBodyMatches,
} from './helpers/chat-acceptance';

export type MonitorStatus = 'passed' | 'failed' | 'unconfigured';
export type MonitorPhase = 'credential' | 'models' | 'chat' | 'complete';
export type MonitorCategory =
  | 'ok'
  | 'missing-credential'
  | 'credential-read-error'
  | 'missing-base-url'
  | 'base-url-not-https'
  | 'invalid-base-url'
  | 'no-catalog-endpoint'
  | 'network-error'
  | 'http-error'
  | 'response-too-large'
  | 'invalid-response'
  | 'no-models'
  | 'completion-mismatch'
  | 'internal-error';

export interface AvailabilityReport {
  configured: boolean;
  status: MonitorStatus;
  phase: MonitorPhase;
  httpStatus: number | null;
  /** Number of discovered ids, never the ids themselves. */
  modelCount?: number;
  /** Truncated SHA-256 of the selected id; raw ids never reach the report. */
  modelIdHash?: string;
  deadlineMs: number;
  latencyMs: number;
  success: boolean;
  category: MonitorCategory;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CredentialFields {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  expectedModels?: string[];
}

export interface MonitorDeadlines {
  discoveryMs: number;
  chatMs: number;
  totalMs: number;
}

export interface MonitorInput {
  /** Contents of the existing canary key=value credential file, when present. */
  fileContents?: string;
  /** Set only when an explicitly configured credential file exists but cannot be read. */
  fileReadError?: boolean;
  environment?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Test-only override; production always uses the exported constants. */
  deadlines?: Partial<MonitorDeadlines>;
}

export const DISCOVERY_DEADLINE_MS = 20_000;
export const CHAT_DEADLINE_MS = 90_000;
/** Shared upper bound: 20s discovery + 90s Chat; body reads inherit the abort. */
export const NETWORK_DEADLINE_MS = DISCOVERY_DEADLINE_MS + CHAT_DEADLINE_MS;
export const MAX_MODELS_RESPONSE_BYTES = 1024 * 1024;
export const MAX_CHAT_RESPONSE_BYTES = 256 * 1024;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_DISCOVERED_MODELS = 200;

const FIELD_ALIASES: Record<keyof CredentialFields, string[]> = {
  provider: ['provider', 'PROVIDER'],
  apiKey: ['apiKey', 'API_KEY', 'key', 'KEY', 'TIMICC_API_KEY'],
  baseUrl: ['baseUrl', 'BASE_URL', 'TIMICC_BASE_URL'],
  expectedModels: ['expectedModels', 'EXPECTED_MODELS'],
};

/** Parse the existing canary key=value format without logging any value. */
export function parseCredentialText(contents: string): CredentialFields {
  const values = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const first = (...names: string[]): string | undefined =>
    names.map((name) => values.get(name)).find((value) => value !== undefined);
  const expectedModels = first(...FIELD_ALIASES.expectedModels)
    ?.split(',')
    .map((value) => validModelId(value))
    .filter((value): value is string => value !== undefined);
  return {
    provider: first(...FIELD_ALIASES.provider),
    apiKey: first(...FIELD_ALIASES.apiKey),
    baseUrl: first(...FIELD_ALIASES.baseUrl),
    expectedModels: expectedModels?.length ? expectedModels : undefined,
  };
}

/**
 * The only TIMICC-specific code: an input-boundary adapter. Once these values
 * become CredentialFields the probe has no provider-specific path.
 */
export function credentialFieldsFromEnvironment(
  environment: Record<string, string | undefined>,
): CredentialFields {
  const baseUrl = environment.TIMICC_BASE_URL?.trim();
  const apiKey = environment.TIMICC_API_KEY?.trim();
  if (!baseUrl && !apiKey) return {};
  return { ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}) };
}

/**
 * Derive a base URL from the shared provider/offering catalog. There is no
 * second provider-to-endpoint table in this monitor.
 */
export function catalogBaseUrl(provider: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, provider)) return undefined;
  const typed = provider as Parameters<typeof providerOfferings>[0];
  const offeringId = defaultOfferingFor(typed, 'apiKey');
  const offering = providerOfferings(typed).find((candidate) => candidate.id === offeringId);
  if (offering?.modelDiscovery?.strategy !== 'openaiCompatible') return undefined;
  return offeringBaseUrl(typed, offeringId);
}

type SecureBaseUrl =
  | { ok: true; url: URL }
  | { ok: false; category: 'base-url-not-https' | 'invalid-base-url' };

export function validateSecureBaseUrl(value: string): SecureBaseUrl {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, category: 'invalid-base-url' };
  }
  if (url.protocol !== 'https:') return { ok: false, category: 'base-url-not-https' };
  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    return { ok: false, category: 'invalid-base-url' };
  }
  // Reserved placeholder names (the catalog uses example.invalid for "the user
  // must replace this") cannot prove a real upstream.
  if (url.hostname === 'invalid' || url.hostname.endsWith('.invalid')) {
    return { ok: false, category: 'invalid-base-url' };
  }
  return { ok: true, url };
}

function endpointUrl(base: URL, relative: string): URL {
  const directory = new URL(base.href);
  if (!directory.pathname.endsWith('/')) directory.pathname += '/';
  const endpoint = new URL(relative, directory);
  if (endpoint.origin !== base.origin) {
    throw new Error('endpoint escaped the configured origin');
  }
  return endpoint;
}

function validModelId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  if (!id || id.length > MAX_MODEL_ID_LENGTH || /[\u0000-\u001f\u007f]/u.test(id)) return undefined;
  return id;
}

function modelIdsFromPayload(payload: unknown): string[] | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (record.error || !Array.isArray(record.data)) return undefined;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of record.data) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const id = validModelId((entry as Record<string, unknown>).id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_DISCOVERED_MODELS) break;
  }
  return ids;
}

function selectChatModel(discovered: string[], expected: string[] | undefined): string {
  for (const wanted of expected ?? []) {
    if (discovered.includes(wanted)) return wanted;
  }
  return discovered[0];
}

type BodyRead =
  | { kind: 'ok'; text: string }
  | { kind: 'too-large' }
  | { kind: 'read-error' };

async function readBoundedText(response: Response, limit: number): Promise<BodyRead> {
  const declared = response.headers.get('content-length');
  if (declared !== null && declared.trim() !== '') {
    const length = Number(declared);
    if (Number.isFinite(length) && length > limit) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'too-large' };
    }
  }
  if (!response.body) {
    try {
      const text = await response.text();
      return Buffer.byteLength(text, 'utf8') > limit ? { kind: 'too-large' } : { kind: 'ok', text };
    } catch {
      return { kind: 'read-error' };
    }
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return { kind: 'too-large' };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { kind: 'ok', text };
  } catch {
    await reader.cancel().catch(() => undefined);
    return { kind: 'read-error' };
  }
}

function jsonBody(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function report(
  startedAt: number,
  now: () => number,
  fields: Omit<AvailabilityReport, 'latencyMs' | 'deadlineMs'> & { deadlineMs?: number },
): AvailabilityReport {
  return {
    ...fields,
    deadlineMs: fields.deadlineMs ?? NETWORK_DEADLINE_MS,
    latencyMs: Math.max(0, Math.round(now() - startedAt)),
  };
}

function failure(
  startedAt: number,
  now: () => number,
  phase: MonitorPhase,
  category: MonitorCategory,
  configured: boolean,
  httpStatus: number | null = null,
  extra: Pick<AvailabilityReport, 'modelCount' | 'modelIdHash'> = {},
): AvailabilityReport {
  return report(startedAt, now, {
    configured,
    status: configured ? 'failed' : 'unconfigured',
    phase,
    httpStatus,
    ...extra,
    success: false,
    category,
  });
}

export async function runMonitor(input: MonitorInput = {}): Promise<AvailabilityReport> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const fetchImpl = input.fetchImpl ?? fetch;
  const deadlines: MonitorDeadlines = {
    discoveryMs: DISCOVERY_DEADLINE_MS,
    chatMs: CHAT_DEADLINE_MS,
    totalMs: NETWORK_DEADLINE_MS,
    ...input.deadlines,
  };

  if (input.fileReadError) {
    return failure(startedAt, now, 'credential', 'credential-read-error', false);
  }

  // The credential file is the primary input. The TIMICC adapter only fills
  // fields the file left empty, and only at this boundary; downstream code has
  // no provider-specific path. A present file still supplies the provider name
  // and expected models, so the two formats cannot silently disagree.
  const fromFile = input.fileContents !== undefined
    ? parseCredentialText(input.fileContents)
    : {};
  const fromEnvironment = credentialFieldsFromEnvironment(input.environment ?? {});
  const fields: CredentialFields = {
    provider: fromFile.provider,
    apiKey: fromFile.apiKey?.trim() || fromEnvironment.apiKey,
    baseUrl: fromFile.baseUrl?.trim() || fromEnvironment.baseUrl,
    expectedModels: fromFile.expectedModels,
  };
  const apiKey = fields.apiKey?.trim();
  if (!apiKey) {
    return failure(startedAt, now, 'credential', 'missing-credential', false);
  }

  const baseText = fields.baseUrl?.trim()
    || (fields.provider ? catalogBaseUrl(fields.provider) : undefined);
  if (!baseText) {
    return failure(
      startedAt,
      now,
      'credential',
      fields.provider ? 'no-catalog-endpoint' : 'missing-base-url',
      true,
    );
  }
  const base = validateSecureBaseUrl(baseText);
  if (!base.ok) return failure(startedAt, now, 'credential', base.category, true);

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  };
  // 20s discovery + 90s Chat share one 110s bound. Each phase gets its own
  // budget, clipped by the overall deadline, and no phase extends the other.
  const clockStart = Date.now();
  const overallDeadlineAt = clockStart + deadlines.totalMs;
  const request = async (
    url: URL,
    init: RequestInit,
    phaseDeadlineAt: number,
  ): Promise<Response | undefined> => {
    const remaining = Math.min(phaseDeadlineAt, overallDeadlineAt) - Date.now();
    if (remaining <= 0) return undefined;
    try {
      return await fetchImpl(url.toString(), {
        ...init,
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(remaining),
      });
    } catch {
      return undefined;
    }
  };

  // Phase 1: real upstream model discovery. Exactly one request, no retry.
  let modelsUrl: URL;
  let chatUrl: URL;
  try {
    modelsUrl = endpointUrl(base.url, 'models');
    chatUrl = endpointUrl(base.url, 'chat/completions');
  } catch {
    return failure(startedAt, now, 'credential', 'invalid-base-url', true);
  }

  const modelsResponse = await request(
    modelsUrl,
    { method: 'GET', headers },
    Date.now() + deadlines.discoveryMs,
  );
  if (!modelsResponse) return failure(startedAt, now, 'models', 'network-error', true);

  const modelsStatus = modelsResponse.status;
  if (modelsStatus < 200 || modelsStatus >= 300) {
    await modelsResponse.body?.cancel().catch(() => undefined);
    return failure(startedAt, now, 'models', 'http-error', true, modelsStatus);
  }
  const modelsRead = await readBoundedText(modelsResponse, MAX_MODELS_RESPONSE_BYTES);
  if (modelsRead.kind === 'too-large') {
    return failure(startedAt, now, 'models', 'response-too-large', true, modelsStatus);
  }
  if (modelsRead.kind === 'read-error') {
    return failure(startedAt, now, 'models', 'network-error', true);
  }
  const modelsPayload = jsonBody(modelsRead.text);
  if (modelsPayload === undefined) {
    return failure(startedAt, now, 'models', 'invalid-response', true, modelsStatus);
  }
  const discovered = modelIdsFromPayload(modelsPayload);
  if (!discovered) {
    return failure(startedAt, now, 'models', 'invalid-response', true, modelsStatus);
  }
  const modelCount = discovered.length;
  if (modelCount === 0) {
    return failure(startedAt, now, 'models', 'no-models', true, modelsStatus, { modelCount });
  }

  // Phase 2: one real Chat completion with a fresh nonce. A 200 with reasoning,
  // truncation, an empty answer or a partial marker is not a pass.
  const modelId = selectChatModel(discovered, fields.expectedModels);
  // Only a hash of the selected id is public, so an echoed key in a model id
  // cannot reach an artifact or log.
  const modelIdHash = createHash('sha256').update(modelId).digest('hex').slice(0, 16);
  const nonce = `XPOD_UPSTREAM_${randomUUID().replace(/-/gu, '')}`;
  const chatResponse = await request(chatUrl, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: `Reply with exactly: ${nonce}` }],
      max_tokens: CHAT_ACCEPTANCE_MAX_OUTPUT_TOKENS,
      temperature: 0,
    }),
  }, Date.now() + deadlines.chatMs);
  if (!chatResponse) {
    return failure(startedAt, now, 'chat', 'network-error', true, null, {
      modelCount,
      modelIdHash,
    });
  }

  const chatStatus = chatResponse.status;
  if (chatStatus !== 200) {
    await chatResponse.body?.cancel().catch(() => undefined);
    return failure(startedAt, now, 'chat', 'http-error', true, chatStatus, {
      modelCount,
      modelIdHash,
    });
  }
  const chatRead = await readBoundedText(chatResponse, MAX_CHAT_RESPONSE_BYTES);
  if (chatRead.kind === 'too-large') {
    return failure(startedAt, now, 'chat', 'response-too-large', true, chatStatus, {
      modelCount,
      modelIdHash,
    });
  }
  if (chatRead.kind === 'read-error') {
    return failure(startedAt, now, 'chat', 'network-error', true, null, {
      modelCount,
      modelIdHash,
    });
  }
  const chatPayload = jsonBody(chatRead.text);
  if (chatPayload === undefined
    || !chatCompletionBodyMatches(chatPayload, nonce)) {
    return failure(startedAt, now, 'chat', 'completion-mismatch', true, chatStatus, {
      modelCount,
      modelIdHash,
    });
  }

  return report(startedAt, now, {
    configured: true,
    status: 'passed',
    phase: 'complete',
    httpStatus: chatStatus,
    modelCount,
    modelIdHash,
    deadlineMs: deadlines.totalMs,
    success: true,
    category: 'ok',
  });
}

export interface CliArguments {
  credentialFile?: string;
  output?: string;
}

export function parseCliArguments(argv: string[]): CliArguments {
  const parsed: CliArguments = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const equals = argument.indexOf('=');
    const name = equals > 0 ? argument.slice(0, equals) : argument;
    const inline = equals > 0 ? argument.slice(equals + 1) : undefined;
    if (name !== '--credential-file' && name !== '--output') continue;
    const value = inline ?? argv[index + 1];
    if (!value) throw new Error('missing command line value');
    if (inline === undefined) index += 1;
    if (name === '--credential-file') parsed.credentialFile = value;
    else parsed.output = value;
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = parseCliArguments(process.argv.slice(2));
  let fileContents: string | undefined;
  let fileReadError = false;
  if (args.credentialFile) {
    try {
      fileContents = await readFile(args.credentialFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fileReadError = true;
    }
  }
  const result = await runMonitor({
    fileContents,
    fileReadError,
    environment: process.env,
    fetchImpl: fetch,
  });
  if (args.output) {
    await mkdir(path.dirname(path.resolve(args.output)), { recursive: true });
    await writeFile(args.output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.success ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => {
    const fallback: AvailabilityReport = {
      configured: false,
      status: 'failed',
      phase: 'credential',
      httpStatus: null,
      deadlineMs: NETWORK_DEADLINE_MS,
      latencyMs: 0,
      success: false,
      category: 'internal-error',
    };
    process.stdout.write(`${JSON.stringify(fallback)}\n`);
    process.exitCode = 1;
  });
}
