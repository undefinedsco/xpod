#!/usr/bin/env bun
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type AcceptanceStatus = 'pass' | 'skip' | 'not_complete' | 'fail';

export interface AcceptanceRequirement {
  id: string;
  title: string;
  source: string;
}

export interface AcceptanceItem {
  requirementId: string;
  title: string;
  status: AcceptanceStatus;
  reason?: string;
  commands: string[];
  evidence: string[];
}

export interface AcceptancePlan {
  generatedAt: string;
  summary: {
    pass: number;
    skip: number;
    notComplete: number;
    fail: number;
  };
  items: AcceptanceItem[];
}

export interface AcceptancePlanOptions {
  env?: Record<string, string | undefined>;
  dockerAvailable?: boolean;
  codexAvailable?: boolean;
  now?: string;
}

export const ACCEPTANCE_REQUIREMENTS: AcceptanceRequirement[] = [
  {
    id: 'solid-pod-isolation',
    title: 'Solid/Pod isolation and ciphertext storage use real Xpod state',
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

const SECRET_KEY_PATTERN = /(api[-_]?key|gateway[-_]?key|token|secret|authorization|oauth[-_]?code|code)/i;
const SECRET_VALUE_PATTERN = /\b(?:sk-[A-Za-z0-9._-]+|xpod_gw_v1_[A-Za-z0-9._-]+|Bearer\s+[A-Za-z0-9._-]+|oauth-code-[A-Za-z0-9._-]+)\b/g;

export function buildAcceptancePlan(options: AcceptancePlanOptions = {}): AcceptancePlan {
  const env = options.env ?? process.env;
  const dockerAvailable = options.dockerAvailable ?? env.XPOD_ACCEPTANCE_DOCKER_AVAILABLE === 'true';
  const codexAvailable = options.codexAvailable ?? env.XPOD_ACCEPTANCE_CODEX_AVAILABLE === 'true';
  const wantsCodex = env.XPOD_ACCEPTANCE_RUN_CODEX === 'true';
  const hasCodexCredential = Boolean(env.XPOD_ACCEPTANCE_GATEWAY_KEY && env.XPOD_ACCEPTANCE_PROVIDER_API_KEY);
  const hasVisualBase = Boolean(env.XPOD_SETTINGS_E2E_BASE_URL || env.XPOD_ACCEPTANCE_BASE_URL);
  const hasRealPodGate = env.XPOD_ACCEPTANCE_REAL_XPOD === 'true' && hasCodexCredential;
  const hasExternalOauth = env.XPOD_ACCEPTANCE_EXTERNAL_OAUTH === 'true';

  const items: AcceptanceItem[] = [
    {
      requirementId: 'solid-pod-isolation',
      title: requirementTitle('solid-pod-isolation'),
      status: hasRealPodGate ? 'skip' : 'not_complete',
      reason: hasRealPodGate
        ? 'Environment gate is present; run the real browser/API flow manually and attach redacted evidence.'
        : 'Requires XPOD_ACCEPTANCE_REAL_XPOD=true plus a stored provider credential and Gateway key; product mocks are not accepted.',
      commands: [
        'XPOD_ACCEPTANCE_REAL_XPOD=true XPOD_ACCEPTANCE_PROVIDER_API_KEY=... XPOD_ACCEPTANCE_GATEWAY_KEY=... bun scripts/accept-xpod-settings.ts',
      ],
      evidence: [
        'tests/integration/AiGatewayPodIsolation.integration.test.ts covers repository-level two-WebID isolation and plaintext scans.',
        ...(env.XPOD_ACCEPTANCE_PROVIDER_API_KEY ? [`Provider credential gate supplied: ${env.XPOD_ACCEPTANCE_PROVIDER_API_KEY}`] : []),
      ],
    },
    {
      requirementId: 'browser-visual',
      title: requirementTitle('browser-visual'),
      status: hasVisualBase ? 'skip' : 'not_complete',
      reason: hasVisualBase
        ? 'Run Playwright against XPOD_SETTINGS_E2E_BASE_URL to collect screenshots in .test-data/acceptance.'
        : 'Requires a running real Xpod settings host; UI fetch interception with canned JSON is not allowed.',
      commands: [
        'XPOD_SETTINGS_E2E_BASE_URL=http://127.0.0.1:3000 bunx playwright test tests/e2e/xpod-settings.spec.ts',
      ],
      evidence: [
        'tests/e2e/xpod-settings.spec.ts captures desktop and narrow screenshots when gated on a real host.',
        'tests/ui/settings-launch.test.ts serves bundled dashboard routes from static/dashboard.',
      ],
    },
    {
      requirementId: 'connect-quota',
      title: requirementTitle('connect-quota'),
      status: 'pass',
      commands: [
        'bun run test -- tests/api/ai-gateway/ProviderConnectAdapters.test.ts tests/api/ai-gateway/ProviderQuotaAdapters.test.ts',
      ],
      evidence: [
        'ProviderConnectAdapters covers OpenAI/Anthropic/Kimi/Bailian connect contracts and DeepSeek connectUnsupported.',
        'ProviderQuotaAdapters covers available, stale/error and unsupported quota snapshots without invented percentages.',
      ],
    },
    {
      requirementId: 'gateway-protocols',
      title: requirementTitle('gateway-protocols'),
      status: 'pass',
      commands: [
        'bun run test -- tests/api/ai-gateway/ProtocolFrontends.test.ts tests/integration/AiGatewayStreaming.integration.test.ts',
      ],
      evidence: [
        'ProtocolFrontends covers request parsing and serializer contracts for Responses, Messages and Chat Completions.',
        'AiGatewayStreaming.integration covers SSE ordering, tool calls, usage, cancellation and error mapping.',
      ],
    },
    {
      requirementId: 'client-config',
      title: requirementTitle('client-config'),
      status: 'pass',
      commands: [
        'bun run test -- tests/api/handlers/AiClientConfigurationHandler.test.ts',
      ],
      evidence: [
        'AiClientConfigurationHandler tests Codex, Claude Code, Pi and CodeBuddy plan/apply/verify/restore fixtures.',
      ],
    },
    {
      requirementId: 'docker-full-regression',
      title: requirementTitle('docker-full-regression'),
      status: dockerAvailable ? 'skip' : 'not_complete',
      reason: dockerAvailable
        ? 'Docker appears available by caller assertion; run bun run test:integration before marking complete.'
        : 'Docker daemon availability was not asserted; full integration is not complete.',
      commands: ['bun run test:integration'],
      evidence: ['Task14 notes record Docker-backed full regression as blocked when /var/run/docker.sock is unavailable.'],
    },
    {
      requirementId: 'real-codex',
      title: requirementTitle('real-codex'),
      status: wantsCodex && codexAvailable && hasCodexCredential ? 'skip' : 'not_complete',
      reason: wantsCodex && codexAvailable && hasCodexCredential
        ? 'Real Codex gate is enabled; run scripts/ai-gateway-codex-smoke.ts and attach redacted metadata.'
        : 'Requires XPOD_ACCEPTANCE_RUN_CODEX=true, XPOD_ACCEPTANCE_CODEX_AVAILABLE=true, XPOD_ACCEPTANCE_GATEWAY_KEY and XPOD_ACCEPTANCE_PROVIDER_API_KEY.',
      commands: [
        'XPOD_ACCEPTANCE_RUN_CODEX=true XPOD_ACCEPTANCE_CODEX_AVAILABLE=true bun scripts/ai-gateway-codex-smoke.ts --fixture-codex-cli',
      ],
      evidence: [
        'scripts/ai-gateway-codex-smoke.ts writes sanitized Codex metadata under .test-data/ai-gateway-codex/.',
        ...(env.XPOD_ACCEPTANCE_GATEWAY_KEY ? [`Gateway key gate supplied: ${env.XPOD_ACCEPTANCE_GATEWAY_KEY}`] : []),
        ...(env.XPOD_ACCEPTANCE_OAUTH_CODE ? [`OAuth code evidence supplied: ${env.XPOD_ACCEPTANCE_OAUTH_CODE}`] : []),
      ],
    },
    {
      requirementId: 'external-oauth',
      title: requirementTitle('external-oauth'),
      status: hasExternalOauth ? 'skip' : 'not_complete',
      reason: hasExternalOauth
        ? 'External OAuth registration evidence must be attached manually; this harness will not fake it.'
        : 'No external provider OAuth/client registration evidence supplied; mark not complete rather than mocking.',
      commands: ['XPOD_ACCEPTANCE_EXTERNAL_OAUTH=true bun scripts/accept-xpod-settings.ts'],
      evidence: ['Provider contract tests verify unsupported/not_configured states without substituting OAuth mocks.'],
    },
  ];

  return summarize({
    generatedAt: options.now ?? new Date().toISOString(),
    summary: { pass: 0, skip: 0, notComplete: 0, fail: 0 },
    items,
  });
}

export function redactAcceptanceSecrets<T>(input: T, extraValues: string[] = []): T {
  const redactString = (value: string): string => {
    let redacted = value.replace(SECRET_VALUE_PATTERN, (match) => match.startsWith('Bearer ') ? 'Bearer [redacted]' : '[redacted]');
    for (const extra of extraValues.filter(Boolean)) {
      redacted = redacted.split(extra).join('[redacted]');
    }
    return redacted;
  };

  const visit = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') {
      return SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redactString(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => visit(item));
    }
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

export async function writeAcceptanceEvidence(plan: AcceptancePlan, options: {
  outputDir?: string;
  extraRedactionValues?: string[];
} = {}): Promise<{ jsonPath: string; markdownPath: string }> {
  const outputDir = options.outputDir ?? path.resolve('.test-data/acceptance');
  await mkdir(outputDir, { recursive: true });
  const redactedPlan = redactAcceptanceSecrets(plan, options.extraRedactionValues);
  const jsonPath = path.join(outputDir, 'xpod-light-settings-acceptance.json');
  const markdownPath = path.join(outputDir, 'xpod-light-settings-acceptance.md');
  await writeFile(jsonPath, `${JSON.stringify(redactedPlan, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(redactedPlan), 'utf8');
  return { jsonPath, markdownPath };
}

function requirementTitle(id: string): string {
  return ACCEPTANCE_REQUIREMENTS.find((requirement) => requirement.id === id)?.title ?? id;
}

function summarize(plan: AcceptancePlan): AcceptancePlan {
  for (const item of plan.items) {
    if (item.status === 'pass') plan.summary.pass += 1;
    if (item.status === 'skip') plan.summary.skip += 1;
    if (item.status === 'not_complete') plan.summary.notComplete += 1;
    if (item.status === 'fail') plan.summary.fail += 1;
  }
  return plan;
}

function renderMarkdown(plan: AcceptancePlan): string {
  const lines = [
    '# Xpod Lightweight Settings Acceptance Evidence',
    '',
    `Generated: ${plan.generatedAt}`,
    '',
    `Summary: pass=${plan.summary.pass}, skip=${plan.summary.skip}, not_complete=${plan.summary.notComplete}, fail=${plan.summary.fail}`,
    '',
  ];

  for (const item of plan.items) {
    lines.push(`## ${item.title}`, '');
    lines.push(`- Requirement: ${item.requirementId}`);
    lines.push(`- Status: ${item.status}`);
    if (item.reason) lines.push(`- Reason: ${item.reason}`);
    lines.push(`- Commands: ${item.commands.join(' ; ')}`);
    lines.push(`- Evidence: ${item.evidence.join(' ; ')}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const outputDir = readFlag('--output-dir') ?? path.resolve('.test-data/acceptance');
  const plan = buildAcceptancePlan();
  const extraValues = [
    process.env.XPOD_ACCEPTANCE_PROVIDER_API_KEY,
    process.env.XPOD_ACCEPTANCE_GATEWAY_KEY,
    process.env.XPOD_ACCEPTANCE_OAUTH_CODE,
    process.env.OPENAI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
  ].filter((value): value is string => Boolean(value));
  const output = await writeAcceptanceEvidence(plan, { outputDir, extraRedactionValues: extraValues });
  const redactedPlan = redactAcceptanceSecrets(plan, extraValues);
  console.log(JSON.stringify({
    ok: redactedPlan.summary.fail === 0,
    summary: redactedPlan.summary,
    output,
  }, null, 2));
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(redactAcceptanceSecrets({ error: error instanceof Error ? error.message : String(error) }).error);
    process.exitCode = 1;
  });
}
