import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ACCEPTANCE_REQUIREMENTS,
  acceptanceRedactionValues,
  buildGateRuntimeEnv,
  buildAcceptanceReport,
  buildAcceptancePlan,
  canonicalAcceptanceArtifactHash,
  executeGateCommand,
  runAcceptance,
  redactAcceptanceSecrets,
  validateRealCodexProvenance,
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
        XPOD_SETTINGS_E2E_ALICE_STATE: '/tmp/alice-state.json',
        XPOD_SETTINGS_E2E_BOB_STATE: '/tmp/bob-state.json',
        XPOD_SETTINGS_E2E_ALICE_POD_URL: 'http://127.0.0.1:3000/alice/',
        XPOD_SETTINGS_E2E_TEST_API_KEY: 'sk-visual-test-key',
        XPOD_ACCEPTANCE_RUN_VISUAL: 'true',
      },
      now: '2026-08-01T00:00:00.000Z',
      executeCommand: async (command) => ({
        command: command.command,
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

  it('uses the selected runAcceptance env for the default command executor', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'xpod-settings-selected-env-'));
    const shimDir = path.join(tempRoot, 'bin');
    await mkdir(shimDir, { recursive: true });
    const bunxShim = path.join(shimDir, 'bunx');
    await writeFile(bunxShim, [
      '#!/bin/sh',
      'if [ "$XPOD_SETTINGS_E2E_BASE_URL" != "http://127.0.0.1:9" ]; then',
      '  echo "missing selected base url" >&2',
      '  exit 41',
      'fi',
      'if [ "$XPOD_SETTINGS_E2E_TEST_API_KEY" != "sk-selected-env-test-key" ]; then',
      '  echo "missing selected api key" >&2',
      '  exit 42',
      'fi',
      'case " $* " in',
      '  *" --reporter=json "*) ;;',
      '  *) echo "missing json reporter" >&2; exit 43 ;;',
      'esac',
      'printf \'{"stats":{"expected":1,"skipped":0,"unexpected":0,"flaky":0}}\\n\'',
      'exit 0',
      '',
    ].join('\n'), 'utf8');
    await chmod(bunxShim, 0o755);

    const report = await runAcceptance({
      env: {
        PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`,
        HOME: process.env.HOME,
        XPOD_ACCEPTANCE_RUN_VISUAL: 'true',
        XPOD_SETTINGS_E2E_BASE_URL: 'http://127.0.0.1:9',
        XPOD_SETTINGS_E2E_ALICE_STATE: path.join(tempRoot, 'alice-state.json'),
        XPOD_SETTINGS_E2E_BOB_STATE: path.join(tempRoot, 'bob-state.json'),
        XPOD_SETTINGS_E2E_ALICE_POD_URL: 'http://127.0.0.1:9/alice/',
        XPOD_SETTINGS_E2E_TEST_API_KEY: 'sk-selected-env-test-key',
      },
      now: '2026-08-01T00:00:00.000Z',
    });

    const item = report.items.find((candidate) => candidate.requirementId === 'browser-visual');
    expect(item?.status).toBe('pass');
    expect(item?.commandResult).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining('"expected":1'),
    });
    expect(item?.reason).toBeUndefined();
  });

  it('rejects all-skipped Playwright JSON command output even when the runner exits zero', async () => {
    const report = await runAcceptance({
      env: {
        XPOD_ACCEPTANCE_RUN_VISUAL: 'true',
        XPOD_SETTINGS_E2E_BASE_URL: 'http://127.0.0.1:3000',
        XPOD_SETTINGS_E2E_ALICE_STATE: '/tmp/alice-state.json',
        XPOD_SETTINGS_E2E_BOB_STATE: '/tmp/bob-state.json',
        XPOD_SETTINGS_E2E_ALICE_POD_URL: 'http://127.0.0.1:3000/alice/',
        XPOD_SETTINGS_E2E_TEST_API_KEY: 'sk-visual-test-key',
      },
      now: '2026-08-01T00:00:00.000Z',
      executeCommand: async (command) => ({
        command: command.command,
        exitCode: 0,
        durationMs: 12,
        stdout: JSON.stringify({
          stats: {
            expected: 0,
            skipped: 4,
            unexpected: 0,
            flaky: 0,
          },
        }),
        stderr: '',
      }),
    });

    expect(report.items.find((candidate) => candidate.requirementId === 'browser-visual')).toMatchObject({
      status: 'fail',
      reason: expect.stringMatching(/skipped|executed/i),
    });
    expect(report.summary).toMatchObject({ fail: 1, healthy: false, complete: false, exitCode: 1 });
  });

  it('validates evidence artifacts with schema, freshness, provenance and matching canonical hash', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'xpod-settings-acceptance-'));
    const artifactPath = path.join(tempRoot, 'oauth.json');
    const artifact = withCanonicalHash({
      schema: 'xpod.acceptance.evidence.v1',
      generatedAt: '2026-08-01T00:00:00.000Z',
      requirementId: 'external-oauth',
      command: ['provider-contract', 'oauth'],
      provenance: {
        provider: 'kimi',
        artifactHash: 'sha256:pending',
      },
      redaction: {
        checked: true,
        secretMaterialFound: false,
      },
    });
    await writeFile(artifactPath, JSON.stringify(artifact), 'utf8');

    const report = await runAcceptance({
      env: {
        XPOD_ACCEPTANCE_EXTERNAL_OAUTH: 'true',
        XPOD_ACCEPTANCE_OAUTH_EVIDENCE: artifactPath,
        XPOD_ACCEPTANCE_EVIDENCE_ROOT: tempRoot,
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

  it('rejects evidence artifacts with forged canonical hash', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'xpod-settings-acceptance-'));
    const artifactPath = path.join(tempRoot, 'oauth.json');
    await writeFile(artifactPath, JSON.stringify(withCanonicalHash({
      schema: 'xpod.acceptance.evidence.v1',
      generatedAt: '2026-08-01T00:00:00.000Z',
      requirementId: 'external-oauth',
      command: ['provider-contract', 'oauth'],
      provenance: {
        provider: 'kimi',
        artifactHash: 'sha256:pending',
      },
      redaction: {
        checked: true,
        secretMaterialFound: false,
      },
    }, 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')), 'utf8');

    const report = await runAcceptance({
      env: {
        XPOD_ACCEPTANCE_EXTERNAL_OAUTH: 'true',
        XPOD_ACCEPTANCE_OAUTH_EVIDENCE: artifactPath,
        XPOD_ACCEPTANCE_EVIDENCE_ROOT: tempRoot,
      },
      now: '2026-08-01T00:05:00.000Z',
      executeCommand: async () => {
        throw new Error('artifact gate should not execute a command');
      },
    });

    expect(report.items.find((item) => item.requirementId === 'external-oauth')).toMatchObject({
      status: 'fail',
      reason: expect.stringMatching(/hash/i),
    });
  });

  it('rejects stale evidence artifacts', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'xpod-settings-acceptance-'));
    const artifactPath = path.join(tempRoot, 'oauth.json');
    await writeFile(artifactPath, JSON.stringify(withCanonicalHash({
      schema: 'xpod.acceptance.evidence.v1',
      generatedAt: '2026-07-30T00:00:00.000Z',
      requirementId: 'external-oauth',
      command: ['provider-contract', 'oauth'],
      provenance: {
        provider: 'kimi',
        artifactHash: 'sha256:pending',
      },
      redaction: {
        checked: true,
        secretMaterialFound: false,
      },
    })), 'utf8');

    const report = await runAcceptance({
      env: {
        XPOD_ACCEPTANCE_EXTERNAL_OAUTH: 'true',
        XPOD_ACCEPTANCE_OAUTH_EVIDENCE: artifactPath,
        XPOD_ACCEPTANCE_EVIDENCE_ROOT: tempRoot,
      },
      now: '2026-08-01T00:05:00.000Z',
      executeCommand: async () => {
        throw new Error('artifact gate should not execute a command');
      },
    });

    expect(report.items.find((item) => item.requirementId === 'external-oauth')).toMatchObject({
      status: 'fail',
      reason: expect.stringMatching(/stale/i),
    });
  });

  it('rejects evidence artifacts with invalid schema', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'xpod-settings-acceptance-'));
    const artifactPath = path.join(tempRoot, 'oauth.json');
    await writeFile(artifactPath, JSON.stringify(withCanonicalHash({
      schema: 'xpod.acceptance.evidence.v0',
      generatedAt: '2026-08-01T00:00:00.000Z',
      requirementId: 'external-oauth',
      command: ['provider-contract', 'oauth'],
      provenance: {
        provider: 'kimi',
        artifactHash: 'sha256:pending',
      },
      redaction: {
        checked: true,
        secretMaterialFound: false,
      },
    })), 'utf8');

    const report = await runAcceptance({
      env: {
        XPOD_ACCEPTANCE_EXTERNAL_OAUTH: 'true',
        XPOD_ACCEPTANCE_OAUTH_EVIDENCE: artifactPath,
        XPOD_ACCEPTANCE_EVIDENCE_ROOT: tempRoot,
      },
      now: '2026-08-01T00:05:00.000Z',
      executeCommand: async () => {
        throw new Error('artifact gate should not execute a command');
      },
    });

    expect(report.items.find((item) => item.requirementId === 'external-oauth')).toMatchObject({
      status: 'fail',
      reason: expect.stringMatching(/schema/i),
    });
  });

  it('rejects evidence artifacts without completed redaction checks', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'xpod-settings-acceptance-'));
    const artifactPath = path.join(tempRoot, 'oauth.json');
    await writeFile(artifactPath, JSON.stringify(withCanonicalHash({
      schema: 'xpod.acceptance.evidence.v1',
      generatedAt: '2026-08-01T00:00:00.000Z',
      requirementId: 'external-oauth',
      command: ['provider-contract', 'oauth'],
      provenance: {
        provider: 'kimi',
        artifactHash: 'sha256:pending',
      },
      redaction: {
        checked: true,
        secretMaterialFound: true,
      },
    })), 'utf8');

    const report = await runAcceptance({
      env: {
        XPOD_ACCEPTANCE_EXTERNAL_OAUTH: 'true',
        XPOD_ACCEPTANCE_OAUTH_EVIDENCE: artifactPath,
        XPOD_ACCEPTANCE_EVIDENCE_ROOT: tempRoot,
      },
      now: '2026-08-01T00:05:00.000Z',
      executeCommand: async () => {
        throw new Error('artifact gate should not execute a command');
      },
    });

    expect(report.items.find((item) => item.requirementId === 'external-oauth')).toMatchObject({
      status: 'fail',
      reason: expect.stringMatching(/redaction/i),
    });
  });

  it('summarizes an empty report as healthy and complete', () => {
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
    expect(spec).toContain('await alice.reload');
    expect(spec).toContain('not.toContainText(testApiKey!)');
    expect(spec).toContain('readPodAiConnectionStatus');
    expect(spec).toContain("source: 'drizzle-solid'");
    expect(spec).toContain('aliceBefore.configuredProviders + 1');
    expect(spec).toContain('bobBefore.configuredProviders');
    expect(spec).toContain('assertSdkGeometryContract');
    expect(spec).not.toContain('if (await firstNavigable.count())');
  });

  it('keeps acceptance provenance endpoint behind an explicit runtime environment gate', async () => {
    const routes = await readFile(path.resolve('src/api/container/routes.ts'), 'utf8');
    const chatHandler = await readFile(path.resolve('src/api/handlers/ChatHandler.ts'), 'utf8');
    const gatewayHandler = await readFile(path.resolve('src/api/handlers/AiGatewayHandler.ts'), 'utf8');

    expect(routes).toContain('XPOD_ACCEPTANCE_ENDPOINTS_ENABLED');
    expect(chatHandler).toContain('acceptanceEndpointsEnabled');
    expect(gatewayHandler).toContain('acceptanceEndpointsEnabled === true');
  });

  it('documents that real Codex acceptance requires Solid client credentials', async () => {
    const docs = await readFile(path.resolve('docs/acceptance/xpod-light-settings.md'), 'utf8');

    expect(docs).toContain('XPOD_ACCEPTANCE_ENDPOINTS_ENABLED=true');
    expect(docs).toContain('XPOD_ACCEPTANCE_API_KEY');
    expect(docs).toContain('sk-base64(client_id:client_secret)');
    expect(docs).toContain('Do not reuse a raw provider key');
  });

  it('records only allowlisted gate environment presence without environment values in JSON or markdown evidence', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'xpod-settings-acceptance-'));
    const secret = 'sk-task12-provider-secret';
    const apiKey = `sk-${Buffer.from('task12-client:task12-secret').toString('base64')}`;
    const oauthCode = 'oauth-code-task12';
    const awsSecret = 'aws-secret-task12-value';
    const randomSecret = 'plain-random-secret-task12';
    const plan = buildAcceptancePlan({
      env: {
        XPOD_ACCEPTANCE_RUN_CODEX: 'true',
        XPOD_ACCEPTANCE_ENDPOINTS_ENABLED: 'true',
        XPOD_ACCEPTANCE_XPOD_BASE_URL: 'http://127.0.0.1:3000',
        XPOD_ACCEPTANCE_PROVIDER_API_KEY: secret,
        XPOD_ACCEPTANCE_API_KEY: apiKey,
        XPOD_ACCEPTANCE_OAUTH_CODE: oauthCode,
        AWS_SECRET_ACCESS_KEY: awsSecret,
        OPENAI_API_KEY: 'sk-task12-openai-secret',
        RANDOM_CONFIG: randomSecret,
      },
      now: '2026-08-01T00:00:00.000Z',
    });

    const output = await writeAcceptanceEvidence(plan, {
      outputDir: tempRoot,
      extraRedactionValues: [secret, apiKey, oauthCode],
    });
    const json = await readFile(output.jsonPath, 'utf8');
    const markdown = await readFile(output.markdownPath, 'utf8');

    expect(json).not.toContain(secret);
    expect(json).not.toContain(apiKey);
    expect(json).not.toContain(oauthCode);
    expect(markdown).not.toContain(secret);
    expect(markdown).not.toContain(apiKey);
    expect(markdown).not.toContain(oauthCode);
    expect(json).not.toContain(awsSecret);
    expect(markdown).not.toContain(awsSecret);
    expect(json).not.toContain('sk-task12-openai-secret');
    expect(markdown).not.toContain('sk-task12-openai-secret');
    expect(json).not.toContain(randomSecret);
    expect(markdown).not.toContain(randomSecret);
    expect(json).toContain('"present": true');
    expect(markdown).toContain('"present":true');
    expect(JSON.parse(json).summary).toMatchObject({ complete: false, healthy: false });
  });

  it('builds command gates with minimal allowlisted runtime env and redacts all secret-like env values', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      XPOD_ACCEPTANCE_RUN_CODEX: 'true',
      XPOD_ACCEPTANCE_ENDPOINTS_ENABLED: 'true',
      XPOD_ACCEPTANCE_XPOD_BASE_URL: 'http://127.0.0.1:3000',
      XPOD_ACCEPTANCE_MODEL: 'gpt-5',
      XPOD_ACCEPTANCE_API_KEY: `sk-${Buffer.from('acceptance-client:acceptance-secret').toString('base64')}`,
      AWS_SECRET_ACCESS_KEY: 'aws-secret-task12-value',
      RANDOM_PASSWORD: 'random-password-task12-value',
      PUBLIC_FLAG: 'must-not-leak-to-child',
    };

    const plan = buildAcceptancePlan({ env, now: '2026-08-01T00:00:00.000Z' });
    const gate = plan.items.find((item) => item.requirementId === 'real-codex')?.gate;
    expect(gate).toMatchObject({
      kind: 'command',
      stdinEnvKey: 'XPOD_ACCEPTANCE_API_KEY',
    });
    expect(gate?.kind === 'command' ? gate.command.join(' ') : '').not.toContain('XPOD_ACCEPTANCE_API_KEY');

    const runtimeEnv = buildGateRuntimeEnv(gate as any, env);
    expect(runtimeEnv).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
    });
    expect(runtimeEnv.XPOD_ACCEPTANCE_API_KEY).toBeUndefined();
    expect(runtimeEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(runtimeEnv.RANDOM_PASSWORD).toBeUndefined();
    expect(runtimeEnv.PUBLIC_FLAG).toBeUndefined();
    expect(acceptanceRedactionValues(env)).toEqual(expect.arrayContaining([
      `sk-${Buffer.from('acceptance-client:acceptance-secret').toString('base64')}`,
      'aws-secret-task12-value',
      'random-password-task12-value',
    ]));
  });

  it('redacts credentialed proxy env values and URL userinfo without changing credential-free proxies', () => {
    const credentialedHttpProxy = 'http://user:proxy-pass@proxy.example:8080';
    const credentialedHttpsProxy = 'https://user%40corp:p%40ss%3Aword@secure.proxy.example:8443/path';
    const credentialedAllProxy = 'socks5://token%3Avalue@all.proxy.example:1080';
    const credentialFreeProxy = 'http://proxy.example:3128';
    const env = {
      PATH: '/usr/bin',
      HTTP_PROXY: credentialedHttpProxy,
      HTTPS_PROXY: credentialedHttpsProxy,
      ALL_PROXY: credentialedAllProxy,
      no_proxy: 'localhost,127.0.0.1',
      NO_PROXY: 'internal.example',
      XPOD_ACCEPTANCE_RUN_VISUAL: 'true',
      XPOD_SETTINGS_E2E_BASE_URL: 'http://127.0.0.1:3000',
      XPOD_SETTINGS_E2E_ALICE_STATE: '/tmp/alice-state.json',
      XPOD_SETTINGS_E2E_BOB_STATE: '/tmp/bob-state.json',
      XPOD_SETTINGS_E2E_ALICE_POD_URL: 'http://127.0.0.1:3000/alice/',
      XPOD_SETTINGS_E2E_TEST_API_KEY: 'sk-visual-test-key',
    };
    const redactionValues = acceptanceRedactionValues(env);
    const gate = buildAcceptancePlan({ env, now: '2026-08-01T00:00:00.000Z' })
      .items.find((item) => item.requirementId === 'browser-visual')?.gate;

    expect(redactionValues).toEqual(expect.arrayContaining([
      credentialedHttpProxy,
      credentialedHttpsProxy,
      credentialedAllProxy,
    ]));
    expect(redactionValues).not.toContain(credentialFreeProxy);
    expect(redactionValues).not.toContain('localhost,127.0.0.1');
    expect(buildGateRuntimeEnv(gate as any, env)).toMatchObject({
      HTTP_PROXY: credentialedHttpProxy,
      HTTPS_PROXY: credentialedHttpsProxy,
      ALL_PROXY: credentialedAllProxy,
      no_proxy: 'localhost,127.0.0.1',
    });

    const redacted = redactAcceptanceSecrets({
      stdout: [
        `http=${credentialedHttpProxy}`,
        `https=${credentialedHttpsProxy}`,
        `all=${credentialedAllProxy}`,
        `plain=${credentialFreeProxy}`,
        'generic=https://encoded%40user:encoded%3Apass@generic.proxy.example:9443/v1',
      ].join('\n'),
    }, redactionValues);
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain(credentialedHttpProxy);
    expect(serialized).not.toContain(credentialedHttpsProxy);
    expect(serialized).not.toContain(credentialedAllProxy);
    expect(serialized).not.toContain('user:proxy-pass');
    expect(serialized).not.toContain('user%40corp:p%40ss%3Aword');
    expect(serialized).not.toContain('token%3Avalue');
    expect(serialized).not.toContain('encoded%40user:encoded%3Apass');
    expect(serialized).toContain('http://[redacted]@proxy.example:8080');
    expect(serialized).toContain('https://[redacted]@secure.proxy.example:8443/path');
    expect(serialized).toContain('socks5://[redacted]@all.proxy.example:1080');
    expect(serialized).toContain('https://[redacted]@generic.proxy.example:9443/v1');
    expect(serialized).toContain(credentialFreeProxy);
  });

  it('terminates timed-out gate process groups and returns a deterministic timeout result', async () => {
    const result = await executeGateCommand({
      kind: 'command',
      command: [process.execPath, '-e', 'setTimeout(() => {}, 10000)'],
      timeoutMs: 50,
      killAfterMs: 50,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(40);
  });

  it('rejects OAuth evidence symlinks and paths outside the acceptance evidence root unless explicitly audited', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'xpod-settings-acceptance-'));
    const evidenceRoot = path.join(tempRoot, 'evidence-root');
    const outsideRoot = path.join(tempRoot, 'outside');
    await mkdir(evidenceRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    const outsideArtifactPath = path.join(outsideRoot, 'oauth.json');
    const symlinkPath = path.join(evidenceRoot, 'oauth-link.json');
    const artifact = withCanonicalHash({
      schema: 'xpod.acceptance.evidence.v1',
      generatedAt: '2026-08-01T00:00:00.000Z',
      requirementId: 'external-oauth',
      command: ['provider-contract', 'oauth'],
      provenance: {
        provider: 'kimi',
        artifactHash: 'sha256:pending',
      },
      redaction: {
        checked: true,
        secretMaterialFound: false,
      },
    });
    await writeFile(outsideArtifactPath, JSON.stringify(artifact), 'utf8');
    await symlink(outsideArtifactPath, symlinkPath);

    const symlinkReport = await runAcceptance({
      env: {
        XPOD_ACCEPTANCE_EXTERNAL_OAUTH: 'true',
        XPOD_ACCEPTANCE_OAUTH_EVIDENCE: symlinkPath,
        XPOD_ACCEPTANCE_EVIDENCE_ROOT: evidenceRoot,
      },
      now: '2026-08-01T00:05:00.000Z',
    });
    expect(symlinkReport.items.find((item) => item.requirementId === 'external-oauth')).toMatchObject({
      status: 'fail',
      reason: expect.stringMatching(/symlink/i),
    });

    const externalReport = await runAcceptance({
      env: {
        XPOD_ACCEPTANCE_EXTERNAL_OAUTH: 'true',
        XPOD_ACCEPTANCE_OAUTH_EVIDENCE: outsideArtifactPath,
        XPOD_ACCEPTANCE_EVIDENCE_ROOT: evidenceRoot,
      },
      now: '2026-08-01T00:05:00.000Z',
    });
    expect(externalReport.items.find((item) => item.requirementId === 'external-oauth')).toMatchObject({
      status: 'fail',
      reason: expect.stringMatching(/acceptance evidence root/i),
    });

    const auditedReport = await runAcceptance({
      env: {
        XPOD_ACCEPTANCE_EXTERNAL_OAUTH: 'true',
        XPOD_ACCEPTANCE_OAUTH_EVIDENCE: outsideArtifactPath,
        XPOD_ACCEPTANCE_EVIDENCE_ROOT: evidenceRoot,
        XPOD_ACCEPTANCE_OAUTH_EVIDENCE_AUDITED_EXTERNAL: 'true',
      },
      now: '2026-08-01T00:05:00.000Z',
    });
    expect(auditedReport.items.find((item) => item.requirementId === 'external-oauth')?.status).toBe('pass');
  });

  it('keeps Alice credential cleanup in a best-effort finally block', async () => {
    const spec = await readFile(path.resolve('tests/e2e/xpod-settings.spec.ts'), 'utf8');
    const credentialTestStart = spec.indexOf("persists Alice API-key credential in her private Pod");
    const credentialTest = spec.slice(credentialTestStart, spec.indexOf("for (const viewport", credentialTestStart));

    expect(credentialTest).toContain('finally');
    expect(credentialTest).toContain('cleanupApiKeyThroughUi(alice)');
    expect(credentialTest).toContain('.catch(() => undefined)');
  });

  it('requires real Codex stream and tool sentinel messages', async () => {
    const script = await readFile(path.resolve('scripts/ai-gateway-codex-smoke.ts'), 'utf8');

    expect(script).toContain('XPOD_REAL_STREAM_SENTINEL');
    expect(script).toContain('XPOD_REAL_TOOL_SENTINEL');
    expect(script).toContain('Real Codex stream run did not return the sentinel');
    expect(script).toContain('Real Codex tool run did not return the sentinel');
  });

  it('rejects real Codex provenance when Solid auth provenance or provider route is not runtime verified', () => {
    expect(() => validateRealCodexProvenance({
      baseUrl: 'http://127.0.0.1:3000',
      model: 'gpt-5',
      apiKey: `sk-${Buffer.from('alice-client:alice-secret').toString('base64')}`,
      provenance: {
        webId: 'https://id.example/alice/profile/card#me',
        authType: 'client_credentials',
        credentialIriHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        secretCellRefHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        providerId: 'openai',
        providerRouteSource: 'user-json',
        xpodBaseUrl: 'http://127.0.0.1:3000',
        generatedAt: '2026-08-01T00:00:00.000Z',
        commandHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        resultHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    })).toThrow(/clientIdHash|provider route/i);
  });

  it('accepts real Codex provenance only when Solid client credentials and Pod credential metadata are cross-checked', () => {
    const clientId = 'alice-client';
    const apiKey = `sk-${Buffer.from(`${clientId}:alice-secret`).toString('base64')}`;
    expect(validateRealCodexProvenance({
      baseUrl: 'http://127.0.0.1:3000',
      model: 'gpt-5',
      apiKey,
      provenance: {
        webId: 'https://id.example/alice/profile/card#me',
        authType: 'client_credentials',
        clientIdHash: `sha256:${canonicalAcceptanceArtifactHash(clientId)}`,
        credentialIriHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        secretCellRefHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        providerId: 'openai',
        providerRouteSource: 'pod-credential',
        xpodBaseUrl: 'http://127.0.0.1:3000',
        generatedAt: '2026-08-01T00:00:00.000Z',
        commandHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        resultHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    })).toMatchObject({
      webId: 'https://id.example/alice/profile/card#me',
      authType: 'client_credentials',
      providerRouteSource: 'pod-credential',
      secretMaterialPrinted: false,
    });
  });

  it('classifies default local protocol and client fixtures as runnable without Docker, OAuth or real Codex credentials', () => {
    const plan = buildAcceptancePlan({
      env: { XPOD_ACCEPTANCE_BASE_URL: 'http://127.0.0.1:3000/' },
      now: '2026-08-01T00:00:00.000Z',
    });

    expect(plan.items.find((item) => item.requirementId === 'connect-quota')?.status).toBe('pass');
    expect(plan.items.find((item) => item.requirementId === 'gateway-protocols')?.status).toBe('pass');
    expect(plan.items.find((item) => item.requirementId === 'client-config')?.status).toBe('pass');
    expect(redactAcceptanceSecrets({
      header: `Bearer ${process.env.XPOD_ACCEPTANCE_API_KEY ?? `sk-${Buffer.from('default-client:default-secret').toString('base64')}`}`,
      nested: { apiKey: 'sk-local-contract' },
    })).toEqual({
      header: 'Bearer [redacted]',
      nested: { apiKey: '[redacted]' },
    });
  });
});

function withCanonicalHash<T extends { provenance: { artifactHash: string } }>(
  artifact: T,
  overrideHash?: string,
): T {
  return {
    ...artifact,
    provenance: {
      ...artifact.provenance,
      artifactHash: overrideHash ?? `sha256:${canonicalAcceptanceArtifactHash(artifact)}`,
    },
  };
}
