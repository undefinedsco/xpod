#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export type AcceptanceStatus = 'pass' | 'skip' | 'not_complete' | 'fail';

export interface AcceptanceRequirement {
  id: string;
  title: string;
  source: string;
}

export interface GateCommand {
  kind: 'command';
  command: string[];
  timeoutMs: number;
  killAfterMs?: number;
  env?: Record<string, { present: boolean }>;
  runtimeEnvKeys?: string[];
  stdinEnvKey?: string;
  resultContract?: CommandResultContract;
}

export type CommandResultContract = {
  kind: 'playwright-json';
  minExecuted: number;
};

export interface ArtifactGate {
  kind: 'artifact';
  path: string;
  maxAgeMs: number;
  rootPath?: string;
  allowExternalEvidence?: boolean;
}

export type AcceptanceGate = GateCommand | ArtifactGate;

export interface CommandResult {
  command: string[];
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface EvidenceArtifact {
  schema: 'xpod.acceptance.evidence.v1';
  generatedAt: string;
  requirementId: string;
  command: string[];
  provenance: {
    provider?: string;
    baseUrl?: string;
    webId?: string;
    artifactHash: string;
    [key: string]: unknown;
  };
  redaction: {
    checked: true;
    secretMaterialFound: false;
  };
}

export interface RealCodexProvenance {
  webId: string;
  gatewayKeyId: string;
  gatewayKeyFingerprint: string;
  credentialIriHash: string;
  credentialRecordHash: string;
  providerId: string;
  providerRouteSource: 'pod-credential';
  xpodBaseUrl: string;
  generatedAt: string;
  commandHash: string;
  resultHash: string;
  secretMaterialPrinted?: false;
}

export interface AcceptanceItem {
  requirementId: string;
  title: string;
  status: AcceptanceStatus;
  mandatory: boolean;
  reason?: string;
  commands: string[];
  evidence: string[];
  gate?: AcceptanceGate;
  commandResult?: CommandResult;
  artifact?: EvidenceArtifact;
}

export interface AcceptanceSummary {
  pass: number;
  skip: number;
  notComplete: number;
  fail: number;
  healthy: boolean;
  complete: boolean;
  allowIncomplete: boolean;
  exitCode: number;
}

export interface AcceptanceReport {
  generatedAt: string;
  summary: AcceptanceSummary;
  items: AcceptanceItem[];
}

export interface AcceptancePlanOptions {
  env?: Record<string, string | undefined>;
  now?: string;
  allowIncomplete?: boolean;
}

export interface RunAcceptanceOptions extends AcceptancePlanOptions {
  executeCommand?: (command: GateCommand) => Promise<CommandResult>;
}

export const ACCEPTANCE_REQUIREMENTS: AcceptanceRequirement[] = [
  {
    id: 'solid-pod-isolation',
    title: 'Solid/Pod isolation and credential storage use real Xpod state',
    source: 'docs/superpowers/plans/2026-07-30-xpod-light-settings.md Task 12 Step 1-2',
  },
  {
    id: 'browser-visual',
    title: 'Models, Pod, Network and Services work at desktop and narrow widths',
    source: 'docs/superpowers/plans/2026-07-30-xpod-light-settings.md Task 12 Step 3',
  },
  {
    id: 'connect-quota',
    title: 'Provider Connect matrix and quota states are contract-backed',
    source: 'docs/superpowers/plans/2026-07-30-xpod-light-settings.md Task 12 Step 4',
  },
  {
    id: 'gateway-protocols',
    title: 'Gateway protocols cover models, Responses, Messages and Chat Completions',
    source: 'docs/superpowers/plans/2026-07-30-xpod-light-settings.md Task 12 Step 5',
  },
  {
    id: 'client-config',
    title: 'Coding-client configuration supports plan/apply/verify/restore',
    source: 'docs/superpowers/plans/2026-07-30-xpod-light-settings.md Task 12 Step 5',
  },
  {
    id: 'docker-full-regression',
    title: 'Docker-backed full integration regression is recorded honestly',
    source: 'docs/superpowers/plans/2026-07-30-xpod-light-settings.md Task 12 Step 7',
  },
  {
    id: 'real-codex',
    title: 'Real Codex uses a stored Xpod credential and Gateway key',
    source: 'docs/superpowers/plans/2026-07-30-xpod-light-settings.md Task 12 Step 6',
  },
  {
    id: 'external-oauth',
    title: 'External OAuth registrations are not replaced by mocks',
    source: 'docs/superpowers/specs/2026-07-30-xpod-light-settings-design.md 独立测试与验收',
  },
];

const SECRET_KEY_PATTERN = /(api[-_]?key|gateway[-_]?key|token|secret|authorization|oauth[-_]?code|password|passwd|credential)$/i;
const SECRET_ENV_KEY_PATTERN = /(secret|token|key|password|passwd|authorization|credential|oauth[-_]?code)/i;
const SECRET_VALUE_PATTERN = /\b(?:sk-[A-Za-z0-9._-]+|xpod_gw_v1_[A-Za-z0-9._-]+|Bearer\s+[A-Za-z0-9._-]+|oauth-code-[A-Za-z0-9._-]+)\b/g;
const URL_CREDENTIAL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s?#@]+@)([^/\s?#]+)/gi;
const URL_WITH_USERINFO_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^/\s?#@]+@[^/\s?#]+/i;
const PROXY_ENV_KEY_PATTERN = /^(https?|all)_proxy$/i;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ACCEPTANCE_EVIDENCE_ROOT = path.resolve('.test-data/acceptance');
const PUBLIC_GATE_ENV_KEYS = new Set([
  'XPOD_ACCEPTANCE_REAL_XPOD',
  'XPOD_ACCEPTANCE_RUN_VISUAL',
  'XPOD_ACCEPTANCE_RUN_DOCKER',
  'XPOD_ACCEPTANCE_RUN_CODEX',
  'XPOD_ACCEPTANCE_EXTERNAL_OAUTH',
  'XPOD_ACCEPTANCE_ENDPOINTS_ENABLED',
  'XPOD_SETTINGS_E2E_BASE_URL',
  'XPOD_SETTINGS_E2E_ALICE_STATE',
  'XPOD_SETTINGS_E2E_BOB_STATE',
  'XPOD_SETTINGS_E2E_ALICE_POD_URL',
  'XPOD_SETTINGS_E2E_TEST_API_KEY',
  'XPOD_ACCEPTANCE_XPOD_BASE_URL',
  'XPOD_ACCEPTANCE_MODEL',
  'XPOD_ACCEPTANCE_GATEWAY_KEY',
  'XPOD_ACCEPTANCE_OAUTH_EVIDENCE',
  'XPOD_ACCEPTANCE_EVIDENCE_ROOT',
  'XPOD_ACCEPTANCE_OAUTH_EVIDENCE_AUDITED_EXTERNAL',
]);
const BASE_RUNTIME_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'SHELL',
  'CI',
  'NO_PROXY',
  'no_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'BUN_INSTALL',
  'NODE_OPTIONS',
  'PLAYWRIGHT_BROWSERS_PATH',
];

export function buildAcceptancePlan(options: AcceptancePlanOptions = {}): AcceptanceReport {
  return buildAcceptanceReport({
    generatedAt: options.now ?? new Date().toISOString(),
    items: planItems(options.env ?? process.env),
    allowIncomplete: options.allowIncomplete === true,
  });
}

export async function runAcceptance(options: RunAcceptanceOptions = {}): Promise<AcceptanceReport> {
  const generatedAt = options.now ?? new Date().toISOString();
  const env = options.env ?? process.env;
  const executeCommand = options.executeCommand ?? ((command: GateCommand) => executeGateCommand(command, env));
  const items = planItems(env);
  const commandResults = new WeakMap<GateCommand, CommandResult>();

  for (const item of items) {
    if (!item.gate) continue;
    if (item.gate.kind === 'command') {
      let result = commandResults.get(item.gate);
      if (!result) {
        result = redactAcceptanceSecrets(await executeCommand(item.gate), acceptanceRedactionValues(env));
        commandResults.set(item.gate, result);
      }
      const failureReason = commandFailureReason(item.gate, result);
      item.commandResult = result;
      item.status = failureReason ? 'fail' : 'pass';
      item.reason = failureReason;
    } else {
      try {
        item.artifact = await validateEvidenceArtifact(item.gate, item.requirementId, generatedAt);
        item.status = 'pass';
        item.reason = undefined;
      } catch (error) {
        item.status = 'fail';
        item.reason = error instanceof Error ? error.message : String(error);
      }
    }
  }

  return buildAcceptanceReport({
    generatedAt,
    items,
    allowIncomplete: options.allowIncomplete === true,
  });
}

export function buildAcceptanceReport(input: {
  generatedAt: string;
  items: AcceptanceItem[];
  allowIncomplete: boolean;
}): AcceptanceReport {
  const summary = input.items.reduce<AcceptanceSummary>((current, item) => {
    if (item.status === 'pass') current.pass += 1;
    if (item.status === 'skip') current.skip += 1;
    if (item.status === 'not_complete') current.notComplete += 1;
    if (item.status === 'fail') current.fail += 1;
    return current;
  }, {
    pass: 0,
    skip: 0,
    notComplete: 0,
    fail: 0,
    healthy: true,
    complete: true,
    allowIncomplete: input.allowIncomplete,
    exitCode: 0,
  });
  const mandatoryIncomplete = input.items.some((item) => item.mandatory && (item.status === 'not_complete' || item.status === 'skip'));
  summary.complete = !mandatoryIncomplete && summary.fail === 0;
  summary.healthy = summary.fail === 0 && (summary.complete || input.allowIncomplete);
  summary.exitCode = summary.healthy ? 0 : 1;
  return {
    generatedAt: input.generatedAt,
    summary,
    items: input.items,
  };
}

export function redactAcceptanceSecrets<T>(input: T, extraValues: string[] = []): T {
  const redactString = (value: string): string => {
    let redacted = value.replace(URL_CREDENTIAL_PATTERN, '$1[redacted]@$3');
    redacted = redacted.replace(SECRET_VALUE_PATTERN, (match) => match.startsWith('Bearer ') ? 'Bearer [redacted]' : '[redacted]');
    for (const extra of extraValues.filter(Boolean)) {
      redacted = redacted.split(extra).join('[redacted]');
    }
    return redacted;
  };

  const visit = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') {
      return SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redactString(value);
    }
    if (Array.isArray(value)) return value.map((item) => visit(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        SECRET_KEY_PATTERN.test(entryKey) ? '[redacted]' : visit(entryValue, entryKey),
      ]));
    }
    return value;
  };

  return visit(input) as T;
}

export async function writeAcceptanceEvidence(report: AcceptanceReport, options: {
  outputDir?: string;
  extraRedactionValues?: string[];
} = {}): Promise<{ jsonPath: string; markdownPath: string }> {
  const outputDir = options.outputDir ?? DEFAULT_ACCEPTANCE_EVIDENCE_ROOT;
  await mkdir(outputDir, { recursive: true });
  const redactedReport = redactAcceptanceSecrets(report, options.extraRedactionValues);
  const jsonPath = path.join(outputDir, 'xpod-light-settings-acceptance.json');
  const markdownPath = path.join(outputDir, 'xpod-light-settings-acceptance.md');
  await writeFile(jsonPath, `${JSON.stringify(redactedReport, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(redactedReport), 'utf8');
  return { jsonPath, markdownPath };
}

function planItems(env: Record<string, string | undefined>): AcceptanceItem[] {
  const baseUrl = env.XPOD_SETTINGS_E2E_BASE_URL ?? env.XPOD_ACCEPTANCE_XPOD_BASE_URL ?? env.XPOD_ACCEPTANCE_BASE_URL;
  const runVisual = env.XPOD_ACCEPTANCE_RUN_VISUAL === 'true';
  const runRealPod = env.XPOD_ACCEPTANCE_REAL_XPOD === 'true';
  const runDocker = env.XPOD_ACCEPTANCE_RUN_DOCKER === 'true';
  const runCodex = env.XPOD_ACCEPTANCE_RUN_CODEX === 'true';
  const runOauth = env.XPOD_ACCEPTANCE_EXTERNAL_OAUTH === 'true';
  const sharedPlaywrightGate = hasRealHostEnv(env) && (runRealPod || runVisual)
    ? playwrightGate(env)
    : undefined;

  return [
    {
      requirementId: 'solid-pod-isolation',
      title: requirementTitle('solid-pod-isolation'),
      mandatory: true,
      status: runRealPod && hasRealHostEnv(env) ? 'skip' : 'not_complete',
      reason: runRealPod
        ? missingRealHostReason(env)
        : 'Requires XPOD_ACCEPTANCE_REAL_XPOD=true plus real Xpod host, A/B auth states, A Pod URL and test API key.',
      commands: ['XPOD_ACCEPTANCE_REAL_XPOD=true XPOD_SETTINGS_E2E_BASE_URL=... XPOD_SETTINGS_E2E_ALICE_STATE=... XPOD_SETTINGS_E2E_BOB_STATE=... bunx playwright test tests/e2e/xpod-settings.spec.ts'],
      evidence: ['tests/e2e/xpod-settings.spec.ts performs UI save/reload, A/B isolation and Pod credential inspection when the real-host gate is complete.'],
      gate: runRealPod ? sharedPlaywrightGate : undefined,
    },
    {
      requirementId: 'browser-visual',
      title: requirementTitle('browser-visual'),
      mandatory: true,
      status: runVisual && hasRealHostEnv(env) ? 'skip' : 'not_complete',
      reason: runVisual
        ? missingRealHostReason(env)
        : 'Requires XPOD_ACCEPTANCE_RUN_VISUAL=true plus real Xpod host, A/B auth states, A Pod URL and test API key; UI fetch interception with canned JSON is not allowed.',
      commands: ['XPOD_ACCEPTANCE_RUN_VISUAL=true XPOD_SETTINGS_E2E_BASE_URL=... XPOD_SETTINGS_E2E_ALICE_STATE=... XPOD_SETTINGS_E2E_BOB_STATE=... XPOD_SETTINGS_E2E_ALICE_POD_URL=... XPOD_SETTINGS_E2E_TEST_API_KEY=... bunx playwright test tests/e2e/xpod-settings.spec.ts --reporter=json'],
      evidence: ['tests/e2e/xpod-settings.spec.ts captures desktop and narrow screenshots and asserts SDK geometry contracts.'],
      gate: runVisual ? sharedPlaywrightGate : undefined,
    },
    fixtureItem('connect-quota', [
      'bun run test -- tests/api/ai-gateway/ProviderConnectAdapters.test.ts tests/api/ai-gateway/ProviderQuotaAdapters.test.ts',
    ], [
      'ProviderConnectAdapters covers OpenAI/Anthropic/Kimi/Bailian connect contracts and DeepSeek connectUnsupported.',
      'ProviderQuotaAdapters covers available, stale/error and unsupported quota snapshots without invented percentages.',
    ]),
    fixtureItem('gateway-protocols', [
      'bun run test -- tests/api/ai-gateway/ProtocolFrontends.test.ts tests/integration/AiGatewayStreaming.integration.test.ts',
    ], [
      'ProtocolFrontends covers request parsing and serializer contracts for Responses, Messages and Chat Completions.',
      'AiGatewayStreaming.integration covers SSE ordering, tool calls, usage, cancellation and error mapping.',
    ]),
    fixtureItem('client-config', [
      'bun run test -- tests/api/handlers/AiClientConfigurationHandler.test.ts',
    ], [
      'AiClientConfigurationHandler tests Codex, Claude Code, Pi and CodeBuddy plan/apply/verify/restore fixtures.',
    ]),
    {
      requirementId: 'docker-full-regression',
      title: requirementTitle('docker-full-regression'),
      mandatory: true,
      status: runDocker ? 'skip' : 'not_complete',
      reason: runDocker ? 'Docker gate is enabled and must execute docker info plus bun run test:integration.' : 'Requires XPOD_ACCEPTANCE_RUN_DOCKER=true.',
      commands: ['docker info', 'bun run test:integration'],
      evidence: ['Full Docker-backed regression is complete only when both commands exit 0.'],
      gate: runDocker ? shellGate(['bash', '-lc', 'docker info && bun run test:integration'], 30 * 60 * 1000, env) : undefined,
    },
    {
      requirementId: 'real-codex',
      title: requirementTitle('real-codex'),
      mandatory: true,
      status: runCodex && hasRealCodexEnv(env) ? 'skip' : 'not_complete',
      reason: runCodex
        ? missingRealCodexReason(env)
        : 'Requires XPOD_ACCEPTANCE_RUN_CODEX=true, XPOD_ACCEPTANCE_ENDPOINTS_ENABLED=true on the Xpod runtime, XPOD_ACCEPTANCE_XPOD_BASE_URL, XPOD_ACCEPTANCE_GATEWAY_KEY with acceptance:read, and a stored provider credential.',
      commands: ['bun scripts/ai-gateway-codex-smoke.ts --real-codex-cli --base-url "$XPOD_ACCEPTANCE_XPOD_BASE_URL" --model "$XPOD_ACCEPTANCE_MODEL" --api-key-stdin'],
      evidence: ['scripts/ai-gateway-codex-smoke.ts real Codex mode writes redacted provenance JSON; fixture flags are not accepted.'],
      gate: runCodex && hasRealCodexEnv(env) ? shellGate([
        'bun',
        'scripts/ai-gateway-codex-smoke.ts',
        '--real-codex-cli',
        '--base-url',
        env.XPOD_ACCEPTANCE_XPOD_BASE_URL!,
        '--model',
        env.XPOD_ACCEPTANCE_MODEL ?? 'gpt-5',
        '--api-key-stdin',
        '--report-dir',
        '.test-data/acceptance/codex-real',
      ], 10 * 60 * 1000, env, {
        stdinEnvKey: 'XPOD_ACCEPTANCE_GATEWAY_KEY',
      }) : undefined,
    },
    {
      requirementId: 'external-oauth',
      title: requirementTitle('external-oauth'),
      mandatory: true,
      status: runOauth && env.XPOD_ACCEPTANCE_OAUTH_EVIDENCE ? 'skip' : 'not_complete',
      reason: runOauth
        ? (env.XPOD_ACCEPTANCE_OAUTH_EVIDENCE ? 'OAuth evidence artifact gate is enabled and must validate.' : 'XPOD_ACCEPTANCE_OAUTH_EVIDENCE is required.')
        : 'No external provider OAuth/client registration evidence supplied; mark not complete rather than mocking.',
      commands: ['XPOD_ACCEPTANCE_EXTERNAL_OAUTH=true XPOD_ACCEPTANCE_OAUTH_EVIDENCE=.test-data/acceptance/oauth.json bun scripts/accept-xpod-settings.ts'],
      evidence: ['OAuth evidence must use schema xpod.acceptance.evidence.v1 with fresh timestamp, provenance hash and redaction checks.'],
      gate: runOauth && env.XPOD_ACCEPTANCE_OAUTH_EVIDENCE ? {
        kind: 'artifact',
        path: env.XPOD_ACCEPTANCE_OAUTH_EVIDENCE,
        maxAgeMs: ONE_DAY_MS,
        rootPath: env.XPOD_ACCEPTANCE_EVIDENCE_ROOT ?? DEFAULT_ACCEPTANCE_EVIDENCE_ROOT,
        allowExternalEvidence: env.XPOD_ACCEPTANCE_OAUTH_EVIDENCE_AUDITED_EXTERNAL === 'true',
      } : undefined,
    },
  ];
}

function fixtureItem(requirementId: string, commands: string[], evidence: string[]): AcceptanceItem {
  return {
    requirementId,
    title: requirementTitle(requirementId),
    mandatory: true,
    status: 'pass',
    commands,
    evidence,
  };
}

function playwrightGate(env: Record<string, string | undefined>): GateCommand {
  return shellGate(['bunx', 'playwright', 'test', 'tests/e2e/xpod-settings.spec.ts', '--reporter=json'], 3 * 60 * 1000, env, {
    runtimeEnvKeys: [
      'XPOD_SETTINGS_E2E_BASE_URL',
      'XPOD_SETTINGS_E2E_ALICE_STATE',
      'XPOD_SETTINGS_E2E_BOB_STATE',
      'XPOD_SETTINGS_E2E_ALICE_POD_URL',
      'XPOD_SETTINGS_E2E_TEST_API_KEY',
    ],
    resultContract: {
      kind: 'playwright-json',
      minExecuted: 1,
    },
  });
}

function shellGate(command: string[], timeoutMs: number, env: Record<string, string | undefined>, options: {
  killAfterMs?: number;
  runtimeEnvKeys?: string[];
  stdinEnvKey?: string;
  resultContract?: CommandResultContract;
} = {}): GateCommand {
  return {
    kind: 'command',
    command,
    timeoutMs,
    killAfterMs: options.killAfterMs,
    env: publicEnv(env),
    runtimeEnvKeys: options.runtimeEnvKeys,
    stdinEnvKey: options.stdinEnvKey,
    resultContract: options.resultContract,
  };
}

function publicEnv(env: Record<string, string | undefined>): Record<string, { present: boolean }> {
  return Object.fromEntries(
    Array.from(PUBLIC_GATE_ENV_KEYS)
      .filter((key) => env[key] !== undefined)
      .map((key) => [key, { present: true }]),
  );
}

function hasRealHostEnv(env: Record<string, string | undefined>): boolean {
  return Boolean(
    env.XPOD_SETTINGS_E2E_BASE_URL &&
    env.XPOD_SETTINGS_E2E_ALICE_STATE &&
    env.XPOD_SETTINGS_E2E_BOB_STATE &&
    env.XPOD_SETTINGS_E2E_ALICE_POD_URL &&
    env.XPOD_SETTINGS_E2E_TEST_API_KEY
  );
}

function missingRealHostReason(env: Record<string, string | undefined>): string {
  if (hasRealHostEnv(env)) return 'Real host gate is enabled and must execute.';
  return 'Requires XPOD_SETTINGS_E2E_BASE_URL, XPOD_SETTINGS_E2E_ALICE_STATE, XPOD_SETTINGS_E2E_BOB_STATE, XPOD_SETTINGS_E2E_ALICE_POD_URL and XPOD_SETTINGS_E2E_TEST_API_KEY.';
}

function hasRealCodexEnv(env: Record<string, string | undefined>): boolean {
  return Boolean(
    env.XPOD_ACCEPTANCE_ENDPOINTS_ENABLED === 'true' &&
    env.XPOD_ACCEPTANCE_XPOD_BASE_URL &&
    env.XPOD_ACCEPTANCE_GATEWAY_KEY
  );
}

function missingRealCodexReason(env: Record<string, string | undefined>): string {
  if (hasRealCodexEnv(env)) return 'Real Codex gate is enabled and must execute.';
  return 'Requires XPOD_ACCEPTANCE_ENDPOINTS_ENABLED=true on the Xpod runtime, XPOD_ACCEPTANCE_XPOD_BASE_URL, and XPOD_ACCEPTANCE_GATEWAY_KEY with acceptance:read; Gateway key must be supplied by env/stdin, not as a command argument.';
}

async function validateEvidenceArtifact(gate: ArtifactGate, requirementId: string, nowIso: string): Promise<EvidenceArtifact> {
  const stats = await lstat(gate.path);
  if (stats.isSymbolicLink()) {
    throw new Error('evidence artifact path must not be a symlink');
  }
  const resolvedPath = await realpath(gate.path);
  const rootPath = await realpath(gate.rootPath ?? DEFAULT_ACCEPTANCE_EVIDENCE_ROOT);
  if (!gate.allowExternalEvidence && !isPathInside(resolvedPath, rootPath)) {
    throw new Error(`evidence artifact must be under the acceptance evidence root: ${rootPath}`);
  }
  const raw = await readFile(resolvedPath, 'utf8');
  const artifact = JSON.parse(raw) as EvidenceArtifact;
  if (artifact.schema !== 'xpod.acceptance.evidence.v1') throw new Error('invalid evidence schema');
  if (artifact.requirementId !== requirementId) throw new Error('evidence requirement mismatch');
  if (!Array.isArray(artifact.command) || artifact.command.length === 0) throw new Error('evidence command missing');
  if (!artifact.provenance || !/^sha256:[a-f0-9]{64}$/i.test(String(artifact.provenance.artifactHash))) {
    throw new Error('evidence provenance hash missing');
  }
  const actualHash = `sha256:${canonicalAcceptanceArtifactHash(artifact)}`;
  if (artifact.provenance.artifactHash !== actualHash) {
    throw new Error('evidence provenance hash mismatch');
  }
  if (artifact.redaction?.checked !== true || artifact.redaction.secretMaterialFound !== false) {
    throw new Error('evidence redaction check missing');
  }
  const generated = Date.parse(artifact.generatedAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(generated) || !Number.isFinite(now) || Math.abs(now - generated) > gate.maxAgeMs) {
    throw new Error('evidence artifact is stale');
  }
  return {
    ...artifact,
    provenance: {
      ...artifact.provenance,
      observedHash: actualHash,
    },
  };
}

export function canonicalAcceptanceArtifactHash(input: unknown): string {
  if (typeof input === 'string' || input instanceof Uint8Array) {
    return createHash('sha256').update(input).digest('hex');
  }
  return createHash('sha256').update(stableStringify(stripArtifactHash(input))).digest('hex');
}

export function validateRealCodexProvenance(input: {
  baseUrl: string;
  model: string;
  gatewayKey: string;
  provenance: unknown;
}): RealCodexProvenance & { secretMaterialPrinted: false } {
  const provenance = input.provenance as Partial<RealCodexProvenance> | undefined;
  if (!provenance || typeof provenance !== 'object') throw new Error('Real Codex provenance missing');
  const expectedFingerprint = `sha256:${canonicalAcceptanceArtifactHash(input.gatewayKey)}`;
  const errors: string[] = [];
  if (!isHttpUrl(provenance.webId)) errors.push('webId must be a valid http URL');
  if (!nonEmptyString(provenance.gatewayKeyId)) errors.push('gatewayKeyId missing');
  if (provenance.gatewayKeyFingerprint !== expectedFingerprint) errors.push('gateway key fingerprint mismatch');
  if (!/^sha256:[a-f0-9]{64}$/i.test(String(provenance.credentialIriHash))) errors.push('credentialIriHash missing');
  if (!/^sha256:[a-f0-9]{64}$/i.test(String(provenance.credentialRecordHash))) errors.push('credentialRecordHash missing');
  if (!nonEmptyString(provenance.providerId)) errors.push('providerId missing');
  if (provenance.providerRouteSource !== 'pod-credential') errors.push('provider route source must be pod-credential');
  if (normalizeUrl(provenance.xpodBaseUrl) !== normalizeUrl(input.baseUrl)) errors.push('xpodBaseUrl mismatch');
  if (!Number.isFinite(Date.parse(String(provenance.generatedAt)))) errors.push('generatedAt missing');
  if (!/^sha256:[a-f0-9]{64}$/i.test(String(provenance.commandHash))) errors.push('commandHash missing');
  if (!/^sha256:[a-f0-9]{64}$/i.test(String(provenance.resultHash))) errors.push('resultHash missing');
  if (JSON.stringify(provenance).includes(input.gatewayKey) || /sk-[A-Za-z0-9._-]+/.test(JSON.stringify(provenance))) {
    errors.push('secret material printed');
  }
  if (errors.length > 0) throw new Error(errors.join('; '));
  return {
    webId: provenance.webId!,
    gatewayKeyId: provenance.gatewayKeyId!,
    gatewayKeyFingerprint: provenance.gatewayKeyFingerprint!,
    credentialIriHash: provenance.credentialIriHash!,
    credentialRecordHash: provenance.credentialRecordHash!,
    providerId: provenance.providerId!,
    providerRouteSource: 'pod-credential',
    xpodBaseUrl: provenance.xpodBaseUrl!,
    generatedAt: provenance.generatedAt!,
    commandHash: provenance.commandHash!,
    resultHash: provenance.resultHash!,
    secretMaterialPrinted: false,
  };
}

export async function executeGateCommand(
  gate: GateCommand,
  sourceEnv: Record<string, string | undefined> = process.env,
): Promise<CommandResult> {
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const [command, ...args] = gate.command;
    const detached = process.platform !== 'win32';
    const child = spawn(command, args, {
      detached,
      env: buildGateRuntimeEnv(gate, sourceEnv),
      stdio: gate.stdinEnvKey ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const killChild = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        if (process.platform !== 'win32' && detached) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };
    if (gate.stdinEnvKey) {
      if (!child.stdin) {
        reject(new Error('Gate stdin stream was not created'));
        return;
      }
      child.stdin.write(sourceEnv[gate.stdinEnvKey] ?? '');
      child.stdin.end();
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killChild('SIGTERM');
      killTimer = setTimeout(() => killChild('SIGKILL'), gate.killAfterMs ?? 2_000);
    }, gate.timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        command: gate.command,
        exitCode: timedOut && exitCode === null ? 124 : exitCode,
        signal,
        durationMs: Date.now() - started,
        stdout: stdout.slice(-4_000),
        stderr: stderr.slice(-4_000),
        timedOut,
      });
    });
  });
}

export function buildGateRuntimeEnv(
  gate: GateCommand,
  sourceEnv: Record<string, string | undefined> = process.env,
): NodeJS.ProcessEnv {
  const keys = new Set([...BASE_RUNTIME_ENV_KEYS, ...(gate.runtimeEnvKeys ?? [])]);
  if (gate.stdinEnvKey) keys.delete(gate.stdinEnvKey);
  return Object.fromEntries(
    Array.from(keys)
      .map((key) => [key, sourceEnv[key]] as const)
      .filter((entry): entry is readonly [string, string] => typeof entry[1] === 'string'),
  );
}

function commandFailureReason(gate: GateCommand, result: CommandResult): string | undefined {
  if (result.timedOut) return `Command timed out after ${gate.timeoutMs}ms.`;
  if (gate.resultContract?.kind === 'playwright-json') {
    const reporterFailure = validatePlaywrightJsonResult(result.stdout, gate.resultContract.minExecuted);
    if (reporterFailure) return reporterFailure;
  }
  if (result.exitCode !== 0) return `Command exited with ${result.exitCode ?? result.signal ?? 'unknown'}.`;
  return undefined;
}

function validatePlaywrightJsonResult(stdout: string, minExecuted: number): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return 'Playwright JSON reporter output was missing or invalid.';
  }
  const stats = (parsed as { stats?: Record<string, unknown> }).stats;
  if (!stats || typeof stats !== 'object') {
    return 'Playwright JSON reporter stats are missing.';
  }
  const expected = numberStat(stats.expected);
  const unexpected = numberStat(stats.unexpected);
  const flaky = numberStat(stats.flaky);
  const skipped = numberStat(stats.skipped);
  const executed = expected + unexpected + flaky;
  if (executed < minExecuted) {
    return `Playwright JSON reporter executed ${executed} tests and skipped ${skipped}; refusing to pass an all-skipped runner.`;
  }
  if (unexpected > 0) {
    const detail = firstPlaywrightError(parsed);
    return `Playwright reported ${unexpected} unexpected test${unexpected === 1 ? '' : 's'}${detail ? `: ${detail}` : '.'}`;
  }
  return undefined;
}

function firstPlaywrightError(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = firstPlaywrightError(item);
      if (message) return message;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;

  const record = value as Record<string, unknown>;
  if (typeof record.message === 'string' && record.message.trim()) {
    return record.message.replace(/\s+/g, ' ').trim().slice(0, 500);
  }
  for (const item of Object.values(record)) {
    const message = firstPlaywrightError(item);
    if (message) return message;
  }
  return undefined;
}

function numberStat(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}

function stripArtifactHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripArtifactHash);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== 'artifactHash')
    .map(([key, item]) => [key, stripArtifactHash(item)]));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isHttpUrl(value: unknown): value is string {
  if (!nonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeUrl(value: unknown): string | undefined {
  if (!isHttpUrl(value)) return undefined;
  const url = new URL(value);
  return url.toString().replace(/\/$/u, '');
}

function requirementTitle(id: string): string {
  return ACCEPTANCE_REQUIREMENTS.find((requirement) => requirement.id === id)?.title ?? id;
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function acceptanceRedactionValues(env: Record<string, string | undefined>): string[] {
  return Array.from(new Set(Object.entries(env)
    .filter(([key, value]) => Boolean(value) && (
      SECRET_ENV_KEY_PATTERN.test(key) ||
      (PROXY_ENV_KEY_PATTERN.test(key) && URL_WITH_USERINFO_PATTERN.test(value!))
    ))
    .map(([, value]) => value!)
  ));
}

function renderMarkdown(report: AcceptanceReport): string {
  const lines = [
    '# Xpod Lightweight Settings Acceptance Evidence',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    `Summary: pass=${report.summary.pass}, skip=${report.summary.skip}, not_complete=${report.summary.notComplete}, fail=${report.summary.fail}, healthy=${report.summary.healthy}, complete=${report.summary.complete}, allow_incomplete=${report.summary.allowIncomplete}`,
    '',
  ];

  for (const item of report.items) {
    lines.push(`## ${item.title}`, '');
    lines.push(`- Requirement: ${item.requirementId}`);
    lines.push(`- Status: ${item.status}`);
    lines.push(`- Mandatory: ${item.mandatory}`);
    if (item.reason) lines.push(`- Reason: ${item.reason}`);
    lines.push(`- Commands: ${item.commands.join(' ; ')}`);
    lines.push(`- Evidence: ${item.evidence.join(' ; ')}`);
    if (item.gate?.kind === 'command' && item.gate.env) lines.push(`- Gate env: ${JSON.stringify(item.gate.env)}`);
    if (item.commandResult) lines.push(`- Command result: exit=${item.commandResult.exitCode}, durationMs=${item.commandResult.durationMs}`);
    if (item.artifact) lines.push(`- Artifact: ${item.artifact.schema}, generatedAt=${item.artifact.generatedAt}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  const outputDir = readFlag('--output-dir') ?? path.resolve('.test-data/acceptance');
  const allowIncomplete = hasFlag('--allow-incomplete');
  const report = await runAcceptance({ allowIncomplete });
  const output = await writeAcceptanceEvidence(report, {
    outputDir,
    extraRedactionValues: acceptanceRedactionValues(process.env),
  });
  const redactedReport = redactAcceptanceSecrets(report, acceptanceRedactionValues(process.env));
  console.log(JSON.stringify({
    ok: redactedReport.summary.healthy,
    healthy: redactedReport.summary.healthy,
    complete: redactedReport.summary.complete,
    allowIncomplete,
    summary: redactedReport.summary,
    output,
  }, null, 2));
  process.exitCode = redactedReport.summary.exitCode;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(redactAcceptanceSecrets({ error: error instanceof Error ? error.message : String(error) }).error);
    process.exitCode = 1;
  });
}
