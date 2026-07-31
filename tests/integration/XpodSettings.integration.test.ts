import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ACCEPTANCE_REQUIREMENTS,
  buildAcceptancePlan,
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
    });
  });

  it('redacts provider secrets, gateway keys and OAuth material from JSON and markdown evidence', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'xpod-settings-acceptance-'));
    const secret = 'sk-task12-provider-secret';
    const gatewayKey = 'xpod_gw_v1_task12_gateway_key';
    const oauthCode = 'oauth-code-task12';
    const plan = buildAcceptancePlan({
      env: {
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
