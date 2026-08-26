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
  writeAcceptanceEvidence,
  type GateCommand,
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
      'external-oauth',
    ]);
    expect(plan.summary).toMatchObject({
      pass: expect.any(Number),
      skip: expect.any(Number),
      notComplete: 4,
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
        timeoutMs: 240_000,
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

  it('surfaces the first Playwright assertion when the runner exits non-zero', async () => {
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
        exitCode: 1,
        durationMs: 30_000,
        stdout: JSON.stringify({
          stats: {
            expected: 3,
            skipped: 0,
            unexpected: 1,
            flaky: 0,
          },
          suites: [{
            specs: [{
              tests: [{
                results: [{
                  errors: [{ message: 'locator.fill: OpenAI account label input was not found' }],
                }],
              }],
            }],
          }],
        }),
        stderr: '',
      }),
    });

    expect(report.items.find((candidate) => candidate.requirementId === 'browser-visual')).toMatchObject({
      status: 'fail',
      reason: expect.stringContaining('OpenAI account label input was not found'),
    });
  });

  it('validates full Playwright contract output while keeping reported command output bounded', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'xpod-settings-contract-output-'));
    const secret = 'sk-large-playwright-contract-secret';
    const contractStdout = JSON.stringify({
      suites: [{
        specs: [{
          tests: [{
            results: [{
              errors: [{ message: `locator.click: ${secret} narrow detail did not open` }],
            }],
          }],
        }],
      }],
      padding: 'x'.repeat(8_000),
      stats: {
        expected: 3,
        skipped: 0,
        unexpected: 1,
        flaky: 0,
      },
    });
    const report = await runAcceptance({
      env: {
        XPOD_ACCEPTANCE_RUN_VISUAL: 'true',
        XPOD_SETTINGS_E2E_BASE_URL: 'http://127.0.0.1:3000',
        XPOD_SETTINGS_E2E_ALICE_STATE: '/tmp/alice-state.json',
        XPOD_SETTINGS_E2E_BOB_STATE: '/tmp/bob-state.json',
        XPOD_SETTINGS_E2E_ALICE_POD_URL: 'http://127.0.0.1:3000/alice/',
        XPOD_SETTINGS_E2E_TEST_API_KEY: secret,
      },
      now: '2026-08-01T00:00:00.000Z',
      executeCommand: async (command) => ({
        command: command.command,
        exitCode: 1,
        durationMs: 30_000,
        stdout: contractStdout.slice(-4_000),
        stderr: '',
        contractStdout,
      }),
    });

    const item = report.items.find((candidate) => candidate.requirementId === 'browser-visual');
    expect(item?.reason).toContain('narrow detail did not open');
    expect(item?.reason).toContain('[redacted]');
    expect(JSON.stringify(item)).not.toContain(secret);
    expect(JSON.stringify(item)).not.toContain('contractStdout');
    expect(item?.commandResult?.stdout.length).toBeLessThanOrEqual(4_000);

    const evidence = await writeAcceptanceEvidence(report, { outputDir: tempRoot });
    const persisted = await readFile(evidence.jsonPath, 'utf8');
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain('contractStdout');
    expect(persisted).not.toContain('x'.repeat(4_001));
  });

  it('runs the shared real-host Playwright gate once for both mandatory requirements', async () => {
    let executionCount = 0;
    const report = await runAcceptance({
      env: {
        XPOD_ACCEPTANCE_REAL_XPOD: 'true',
        XPOD_ACCEPTANCE_RUN_VISUAL: 'true',
        XPOD_SETTINGS_E2E_BASE_URL: 'http://127.0.0.1:3000',
        XPOD_SETTINGS_E2E_ALICE_STATE: '/tmp/alice-state.json',
        XPOD_SETTINGS_E2E_BOB_STATE: '/tmp/bob-state.json',
        XPOD_SETTINGS_E2E_ALICE_POD_URL: 'http://127.0.0.1:3000/alice/',
        XPOD_SETTINGS_E2E_TEST_API_KEY: 'sk-shared-playwright-test-key',
      },
      now: '2026-08-01T00:00:00.000Z',
      executeCommand: async (command) => {
        executionCount += 1;
        return {
          command: command.command,
          exitCode: 0,
          durationMs: 12,
          stdout: JSON.stringify({
            stats: {
              expected: 4,
              skipped: 0,
              unexpected: 0,
              flaky: 0,
            },
          }),
          stderr: '',
        };
      },
    });

    expect(executionCount).toBe(1);
    expect(report.items.find((item) => item.requirementId === 'solid-pod-isolation')?.status).toBe('pass');
    expect(report.items.find((item) => item.requirementId === 'browser-visual')?.status).toBe('pass');
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
    expect(spec).toContain('XPOD_SETTINGS_E2E_TEST_API_KEY');
    expect(spec).toContain('completeApiKeyThroughUi');
    expect(spec).not.toContain('assertPlaintextPodCredential');
    expect(spec).toContain('assertSdkGeometryContract');
    expect(spec).toContain("getByLabel('OpenAI API Key 输入')");
    expect(spec).toContain("getByRole('button', { name: '保存 OpenAI API Key' })");
    expect(spec).toContain("'/settings/models'");
    expect(spec).toContain("'/settings/pod'");
    expect(spec).toContain("'/settings/services'");
    expect(spec).toContain("'/dashboard/network'");
    expect(spec).not.toContain("'/dashboard/models'");
    expect(spec).not.toContain("'/dashboard/pod'");
    expect(spec).not.toContain("'/dashboard/services'");
    expect(spec).not.toContain('podResourceUrl(');
    expect(spec).not.toContain("new URL('/settings/credentials.ttl'");
    expect(spec).toContain("alice.reload({ waitUntil: 'domcontentloaded' })");
    expect(spec).toContain("openModule(bob, '/settings/models', 'Models')");
    expect(spec).toContain("getByRole('option', { name: 'OpenAI' })");
    expect(spec).toContain("getByRole('button', { name: '返回列表' })");
    expect(spec).toContain("waitUntil: 'domcontentloaded'");
    expect(spec).not.toContain("waitUntil: 'networkidle'");
    expect(spec).toContain("getByRole('link', { name: label })");
    expect(spec).toContain('page.setDefaultTimeout(30_000)');
    expect(spec).not.toContain("getByRole('link', { name: label }).or(");
    expect(spec).not.toContain('Alice OpenAI acceptance');
    expect(spec).not.toContain('if (await firstNavigable.count())');
  });

  it('records only allowlisted gate environment presence without environment values in JSON or markdown evidence', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'xpod-settings-acceptance-'));
    const secret = 'sk-task12-provider-secret';
    const oauthCode = 'oauth-code-task12';
    const awsSecret = 'aws-secret-task12-value';
    const randomSecret = 'plain-random-secret-task12';
    const plan = buildAcceptancePlan({
      env: {
        XPOD_ACCEPTANCE_RUN_DOCKER: 'true',
        XPOD_ACCEPTANCE_XPOD_BASE_URL: 'http://127.0.0.1:3000',
        XPOD_ACCEPTANCE_PROVIDER_API_KEY: secret,
        XPOD_ACCEPTANCE_OAUTH_CODE: oauthCode,
        AWS_SECRET_ACCESS_KEY: awsSecret,
        OPENAI_API_KEY: 'sk-task12-openai-secret',
        RANDOM_CONFIG: randomSecret,
      },
      now: '2026-08-01T00:00:00.000Z',
    });

    const output = await writeAcceptanceEvidence(plan, {
      outputDir: tempRoot,
      extraRedactionValues: [secret, oauthCode],
    });
    const json = await readFile(output.jsonPath, 'utf8');
    const markdown = await readFile(output.markdownPath, 'utf8');

    expect(json).not.toContain(secret);
    expect(json).not.toContain(oauthCode);
    expect(markdown).not.toContain(secret);
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
      XPOD_ACCEPTANCE_XPOD_BASE_URL: 'http://127.0.0.1:3000',
      XPOD_ACCEPTANCE_PROVIDER_API_KEY: 'sk-provider-acceptance-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret-task12-value',
      RANDOM_PASSWORD: 'random-password-task12-value',
      PUBLIC_FLAG: 'must-not-leak-to-child',
    };

    const gate: GateCommand = {
      kind: 'command',
      command: ['true'],
      timeoutMs: 1_000,
      runtimeEnvKeys: ['PATH', 'HOME'],
    };

    const runtimeEnv = buildGateRuntimeEnv(gate, env);
    expect(runtimeEnv).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
    });
    expect(runtimeEnv.XPOD_ACCEPTANCE_PROVIDER_API_KEY).toBeUndefined();
    expect(runtimeEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(runtimeEnv.RANDOM_PASSWORD).toBeUndefined();
    expect(runtimeEnv.PUBLIC_FLAG).toBeUndefined();
    expect(acceptanceRedactionValues(env)).toEqual(expect.arrayContaining([
      'sk-provider-acceptance-secret',
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

  it('retains full result-contract stdout internally when the public command tail is truncated', async () => {
    const result = await executeGateCommand({
      kind: 'command',
      command: [
        process.execPath,
        '-e',
        "process.stdout.write(JSON.stringify({ padding: 'x'.repeat(8000), stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0 } }))",
      ],
      timeoutMs: 5_000,
      resultContract: {
        kind: 'playwright-json',
        minExecuted: 1,
      },
    });

    expect(result.stdout.length).toBeLessThanOrEqual(4_000);
    expect(result.contractStdout?.length).toBeGreaterThan(4_000);
    expect(JSON.parse(result.contractStdout!).stats.expected).toBe(1);
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
    const credentialTestStart = spec.indexOf("persists Alice API-key credential in her Pod");
    const credentialTest = spec.slice(credentialTestStart, spec.indexOf("for (const viewport", credentialTestStart));

    expect(credentialTest).toContain('finally');
    expect(credentialTest).toContain('cleanupApiKeyThroughUi(alice)');
    expect(credentialTest).toContain('.catch(() => undefined)');
  });

  it('classifies the local provider and routing fixtures as runnable without Docker or external OAuth credentials', () => {
    const plan = buildAcceptancePlan({
      env: { XPOD_ACCEPTANCE_BASE_URL: 'http://127.0.0.1:3000/' },
      now: '2026-08-01T00:00:00.000Z',
    });

    expect(plan.items.find((item) => item.requirementId === 'provider-pod-management')?.status).toBe('pass');
    expect(plan.items.find((item) => item.requirementId === 'ai-routing-boundary')?.status).toBe('pass');
    expect(redactAcceptanceSecrets({
      header: 'Bearer sk-local-contract',
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
