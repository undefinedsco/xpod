import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ACCEPTANCE_REQUIREMENTS,
  buildAcceptanceReport,
  buildAcceptancePlan,
  runAcceptance,
  redactAcceptanceSecrets,
  writeAcceptanceEvidence,
} from '../../scripts/accept-xpod-settings';

describe('Xpod settings product acceptance harness', () => {
  let tempRoot: string | undefined;

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it('maps every product requirement to executable evidence or an honest not-complete gate', () => {
    const plan = buildAcceptancePlan({
      env: {},
      dockerAvailable: false,
      codexAvailable: false,
      now: '2026-08-01T00:00:00.000Z',
    });

    const requirementIds = new Set(ACCEPTANCE_REQUIREMENTS.map((requirement) => requirement.id));
    expect(requirementIds).toEqual(new Set(plan.items.map((item) => item.requirementId)));
    expect(plan.items.every((item) => item.commands.length > 0 || item.evidence.length > 0)).toBe(true);
    expect(plan.items.filter((item) => item.status === 'not_complete').map((item) => item.requirementId)).toEqual([
      'solid-pod-isolation',
      'browser-visual',
      'docker-full-regression',
      'real-codex',
      'external-oauth',
    ]);
    expect(plan.items.find((item) => item.requirementId === 'real-codex')?.reason)
      .toMatch(/XPOD_ACCEPTANCE_RUN_CODEX/);
    expect(plan.summary).toMatchObject({
      pass: expect.any(Number),
      skip: expect.any(Number),
      notComplete: 5,
      fail: 0,
      healthy: false,
      complete: false,
    });
  });

  it('marks default acceptance incomplete and exits non-zero unless allow-incomplete is explicit', async () => {
    const report = await runAcceptance({
      env: {},
      now: '2026-08-01T00:00:00.000Z',
      executeCommand: async () => {
        throw new Error('default run must not execute missing gates');
      },
    });
    const allowed = await runAcceptance({
      env: {},
      allowIncomplete: true,
      now: '2026-08-01T00:00:00.000Z',
      executeCommand: async () => {
        throw new Error('default run must not execute missing gates');
      },
    });

    expect(report.summary).toMatchObject({ healthy: false, complete: false, exitCode: 1, allowIncomplete: false });
    expect(allowed.summary).toMatchObject({ healthy: true, complete: false, exitCode: 0, allowIncomplete: true });
  });

  it('executes enabled command gates and converts command failures into fail status', async () => {
    const report = await runAcceptance({
      env: {
        XPOD_SETTINGS_E2E_BASE_URL: 'http://127.0.0.1:3000',
        XPOD_ACCEPTANCE_RUN_VISUAL: 'true',
      },
      now: '2026-08-01T00:00:00.000Z',
      executeCommand: async (command) => ({
        command,
        exitCode: 7,
        durationMs: 12,
        stdout: 'visual stdout',
        stderr: 'sk-visual-secret',
      }),
    });

    const item = report.items.find((candidate) => candidate.requirementId === 'browser-visual');
    expect(item).toMatchObject({
      status: 'fail',
      gate: expect.objectContaining({
        kind: 'command',
        command: expect.arrayContaining(['bunx', 'playwright', 'test', 'tests/e2e/xpod-settings.spec.ts']),
        timeoutMs: expect.any(Number),
      }),
      commandResult: expect.objectContaining({ exitCode: 7, stderr: '[redacted]' }),
    });
    expect(report.summary).toMatchObject({ fail: 1, healthy: false, complete: false, exitCode: 1 });
  });

  it('validates evidence artifacts with schema, freshness, provenance and redaction checks', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'xpod-settings-acceptance-'));
    const artifactPath = path.join(tempRoot, 'oauth.json');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(artifactPath, JSON.stringify({
      schema: 'xpod.acceptance.evidence.v1',
      generatedAt: '2026-08-01T00:00:00.000Z',
      requirementId: 'external-oauth',
      command: ['provider-contract', 'oauth'],
      provenance: {
        provider: 'kimi',
        artifactHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      redaction: {
        checked: true,
        secretMaterialFound: false,
      },
    }), 'utf8'));

    const report = await runAcceptance({
      env: {
        XPOD_ACCEPTANCE_EXTERNAL_OAUTH: 'true',
        XPOD_ACCEPTANCE_OAUTH_EVIDENCE: artifactPath,
      },
      now: '2026-08-01T00:05:00.000Z',
      executeCommand: async () => {
        throw new Error('artifact gate should not execute a command');
      },
    });

    expect(report.items.find((item) => item.requirementId === 'external-oauth')).toMatchObject({
      status: 'pass',
      artifact: expect.objectContaining({
        schema: 'xpod.acceptance.evidence.v1',
        provenance: expect.objectContaining({ provider: 'kimi' }),
      }),
    });
  });

  it('rejects stale or secret-bearing evidence artifacts', () => {
    const report = buildAcceptanceReport({
      generatedAt: '2026-08-01T00:00:00.000Z',
      items: [],
      allowIncomplete: false,
    });

    expect(report.summary).toMatchObject({ healthy: true, complete: true, exitCode: 0 });
  });

  it('keeps the Playwright real-host spec mandatory once its environment gate is enabled', async () => {
    const spec = await readFile(path.resolve('tests/e2e/xpod-settings.spec.ts'), 'utf8');

    expect(spec).toContain('XPOD_SETTINGS_E2E_BASE_URL');
    expect(spec).toContain('XPOD_SETTINGS_E2E_ALICE_STATE');
    expect(spec).toContain('XPOD_SETTINGS_E2E_BOB_STATE');
    expect(spec).toContain('XPOD_SETTINGS_E2E_ALICE_POD_URL');
    expect(spec).toContain('XPOD_SETTINGS_E2E_TEST_API_KEY');
    expect(spec).toContain('completeApiKeyThroughUi');
    expect(spec).toContain('assertCiphertextOnlyPodCredential');
    expect(spec).toContain('assertSdkGeometryContract');
    expect(spec).not.toContain('if (await firstNavigable.count())');
  });

  it('redacts provider secrets, gateway keys and OAuth material from JSON and markdown evidence', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'xpod-settings-acceptance-'));
    const secret = 'sk-task12-provider-secret';
    const gatewayKey = 'xpod_gw_v1_task12_gateway_key';
    const oauthCode = 'oauth-code-task12';
    const plan = buildAcceptancePlan({
      env: {
        XPOD_ACCEPTANCE_RUN_CODEX: 'true',
        XPOD_ACCEPTANCE_XPOD_BASE_URL: 'http://127.0.0.1:3000',
        XPOD_ACCEPTANCE_PROVIDER_API_KEY: secret,
        XPOD_ACCEPTANCE_GATEWAY_KEY: gatewayKey,
        XPOD_ACCEPTANCE_OAUTH_CODE: oauthCode,
      },
      dockerAvailable: false,
      codexAvailable: false,
      now: '2026-08-01T00:00:00.000Z',
    });

    const output = await writeAcceptanceEvidence(plan, {
      outputDir: tempRoot,
      extraRedactionValues: [secret, gatewayKey, oauthCode],
    });
    const json = await readFile(output.jsonPath, 'utf8');
    const markdown = await readFile(output.markdownPath, 'utf8');

    expect(json).not.toContain(secret);
    expect(json).not.toContain(gatewayKey);
    expect(json).not.toContain(oauthCode);
    expect(markdown).not.toContain(secret);
    expect(markdown).not.toContain(gatewayKey);
    expect(markdown).not.toContain(oauthCode);
    expect(json).toContain('[redacted]');
    expect(markdown).toContain('[redacted]');
    expect(JSON.parse(json).summary).toMatchObject({ complete: false, healthy: false });
  });

  it('classifies default local protocol and client fixtures as runnable without Docker, OAuth or real Codex credentials', () => {
    const plan = buildAcceptancePlan({
      env: { XPOD_ACCEPTANCE_BASE_URL: 'http://127.0.0.1:3000/' },
      dockerAvailable: false,
      codexAvailable: false,
      now: '2026-08-01T00:00:00.000Z',
    });

    expect(plan.items.find((item) => item.requirementId === 'connect-quota')?.status).toBe('pass');
    expect(plan.items.find((item) => item.requirementId === 'gateway-protocols')?.status).toBe('pass');
    expect(plan.items.find((item) => item.requirementId === 'client-config')?.status).toBe('pass');
    expect(redactAcceptanceSecrets({
      header: `Bearer ${process.env.XPOD_ACCEPTANCE_GATEWAY_KEY ?? 'xpod_gw_v1_default'}`,
      nested: { apiKey: 'sk-local-contract' },
    })).toEqual({
      header: 'Bearer [redacted]',
      nested: { apiKey: '[redacted]' },
    });
  });
});
