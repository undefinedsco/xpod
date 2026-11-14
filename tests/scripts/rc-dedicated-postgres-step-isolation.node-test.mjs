/**
 * Cross-step shell isolation for the RC bootstrap consumer.
 *
 * GitHub Actions runs every `run:` block in its own shell, so a variable
 * defined by the secret-validation step is unbound in the next step. These
 * tests take the REAL consuming step from candidate.yml, split off its
 * prologue, and execute each script as a standalone file in a clean process:
 *   - the pre-fix shape (bare `$env_file`) aborts with "unbound variable";
 *   - the shipped prologue re-derives the canonical path and proceeds;
 *   - a missing env file fails closed instead of continuing.
 *
 * Shell fidelity matters here. The RC steps declare no `shell:` override, so
 * the runner default applies: on Linux that is `bash -e <script>` when bash is
 * present. The step body itself starts with `set -euo pipefail` and uses
 * `[[ ... =~ ... ]]`, which a POSIX-only `/bin/sh` (dash on Ubuntu) rejects
 * before executing anything. Spawning `sh` here made the suite pass on macOS
 * (where /bin/sh is bash) and fail on Ubuntu CI with
 * `sh: 1: set: Illegal option -o pipefail`. The tests below therefore encode
 * the runner shell explicitly and assert the real invariant instead of relying
 * on whatever `/bin/sh` happens to be.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  deploySteps,
  findStep,
  runShell,
  tempDir,
  writeExecutable,
} from './rc-dedicated-postgres-fixture.mjs';

const producer = findStep(deploySteps(), 'Validate RC runtime secret isolation');
const consumer = findStep(deploySteps(), 'Verify RC-only PostgreSQL and bootstrap');
const consumerScript = consumer.run;
const prologue = consumerScript.split('node scripts/render-rc-manifests.cjs')[0];

/**
 * The shell GitHub uses for a `run:` block without an explicit `shell:`.
 * GitHub documents `bash -e {0}` for Linux/macOS when bash is available, which
 * is exactly how the RC job's runner is provisioned. The step body adds `-u`
 * and `pipefail` through its own `set` line, so the invocation stays `bash -e`.
 */
const RUNNER_SHELL = 'bash';
const RUNNER_ARGS = [ '-e' ];

/** Write a script to a file and execute it the way the runner does. */
function runAsStepScript(t, source, env) {
  const directory = tempDir(t, 'xpod-rc-step-');
  const scriptPath = path.join(directory, 'step.sh');
  writeFileSync(scriptPath, source);
  return runShell(RUNNER_SHELL, RUNNER_ARGS, scriptPath, { env });
}

/** Which POSIX shell is `/bin/sh` here, and does it accept `pipefail`? */
function shIdentity() {
  const probe = spawnSync('sh', [ '-c', 'set -o pipefail; printf PIPEFAIL_ACCEPTED' ], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { PATH: process.env.PATH },
  });
  const output = `${probe.stdout}${probe.stderr}`;
  return {
    status: probe.status,
    accepted: output.includes('PIPEFAIL_ACCEPTED'),
    rejected: /Illegal option -o pipefail/.test(output),
    output,
  };
}

test('the producing step keeps env_file step-local (no GITHUB_ENV export)', () => {
  assert.match(producer.run, /env_file="\$\{RUNNER_TEMP\}\/xpod-rc\.env"/);
  assert.equal(/env_file.*>>\s*"?\$GITHUB_ENV/.test(producer.run), false);
});

test('the RC steps run under the runner bash, not a POSIX-only sh', () => {
  // No `shell:` override means the runner default applies on both steps. If a
  // future change pinned them to `sh`, every Ubuntu run would abort on the
  // `set -euo pipefail` line before any assertion could execute.
  for (const step of [ producer, consumer ]) {
    assert.ok(step.shell === undefined || step.shell === 'bash',
      `${step.name} must not select a non-bash shell (found ${JSON.stringify(step.shell)})`);
  }

  // Prove the selected shell really supports the body's constructs rather than
  // assuming it: `pipefail`, `[[ … ]]` and `=~` all appear in the step.
  const probe = spawnSync(RUNNER_SHELL, [ '-e', '-c',
    'set -euo pipefail; [[ xpod-rc =~ ^xpod-[a-z]+$ ]] && printf SHELL_OK' ], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { PATH: process.env.PATH },
  });
  assert.equal(probe.status, 0, `bash must be available: ${probe.stderr}`);
  assert.equal(probe.stdout, 'SHELL_OK');
});

test('a POSIX-only /bin/sh cannot execute this step body (dash regression)', () => {
  const sh = shIdentity();
  if (sh.rejected) {
    // Debian/Ubuntu CI: dash refuses `pipefail` outright. This is the precise
    // failure the old `spawn('sh')` version hit, so pin it as a regression.
    assert.notEqual(sh.status, 0, 'dash must reject set -o pipefail');
    assert.equal(sh.accepted, false);
    const body = runShell('sh', [ '-c' ], 'set -euo pipefail\n: "$env_file"\necho UNREACHABLE', {
      env: { PATH: process.env.PATH },
    });
    assert.notEqual(body.status, 0);
    assert.equal(String(body.stdout).includes('UNREACHABLE'), false);
  } else {
    // macOS/other hosts whose /bin/sh is bash-compatible: the same body is
    // accepted. Asserting the actual identity keeps this check honest instead
    // of skipping it; whichever branch runs, `sh` is never used for the step.
    assert.equal(sh.accepted, true, sh.output);
    assert.equal(sh.status, 0);
  }
});

test('the legacy cross-step reference aborts in a clean shell', (t) => {
  const directory = tempDir(t, 'xpod-rc-step-old-');
  const result = runAsStepScript(t, 'set -euo pipefail\n: "$env_file"\necho reached', {
    RUNNER_TEMP: directory,
    GITHUB_RUN_ID: '12345',
    GITHUB_RUN_ATTEMPT: '1',
    SEALOS_NAMESPACE: 'ns-test',
  });
  assert.notEqual(result.status, 0, 'an unbound cross-step variable must fail');
  assert.match(`${result.stdout}${result.stderr}`, /env_file: (unbound variable|parameter not set)/);
  assert.equal(String(result.stdout).includes('reached'), false);
});

test('the shipped prologue re-derives env_file and proceeds', (t) => {
  const directory = tempDir(t, 'xpod-rc-step-new-');
  const envPath = path.join(directory, 'xpod-rc.env');
  writeFileSync(envPath, 'CSS_IDENTITY_DB_URL=postgresql://xpod_rc:synthetic@xpod-rc-rdf-postgres:5432/xpod_rc\n', { mode: 0o600 });
  const bin = path.join(directory, 'bin');
  mkdirSync(bin);
  writeExecutable(path.join(bin, 'kubectl'), '#!/bin/sh\nexit 0\n');

  assert.ok(prologue.includes('env_file='), 'prologue must define env_file');
  assert.equal(prologue.trimEnd().endsWith('\\'), false, 'prologue must not end on a continuation');

  const result = runAsStepScript(t, `${prologue}\necho ENV_FILE_BOUND:$env_file`, {
    PATH: `${bin}:${process.env.PATH}`,
    RUNNER_TEMP: directory,
    GITHUB_RUN_ID: '12345',
    GITHUB_RUN_ATTEMPT: '1',
    SEALOS_NAMESPACE: 'ns-test',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(String(result.stdout).includes(`ENV_FILE_BOUND:${envPath}`), result.stdout);
});

test('a missing canonical env file fails closed', (t) => {
  const directory = tempDir(t, 'xpod-rc-step-missing-');
  const result = runAsStepScript(t, prologue, {
    RUNNER_TEMP: directory,
    GITHUB_RUN_ID: '1',
    GITHUB_RUN_ATTEMPT: '1',
    SEALOS_NAMESPACE: 'ns-test',
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /validated RC env file is missing/);
});

test('the consumer never echoes or cats the validated env file', () => {
  assert.equal(/echo.*\$env_file/.test(consumerScript), false);
  assert.equal(/cat\s+"\$env_file"/.test(consumerScript), false);
  assert.match(consumerScript, /env_file="\$\{RUNNER_TEMP\}\/xpod-rc\.env"/);
});

test('the executed prologue writes no secret material to stdout or stderr', (t) => {
  const directory = tempDir(t, 'xpod-rc-step-secret-');
  const envPath = path.join(directory, 'xpod-rc.env');
  // Synthetic sentinel: if any code path echoed the file, this value surfaces.
  const sentinel = 'synthetic-sentinel-do-not-print';
  writeFileSync(envPath, `CSS_IDENTITY_DB_URL=postgresql://xpod_rc:${sentinel}@xpod-rc-rdf-postgres:5432/xpod_rc\n`, { mode: 0o600 });
  const result = runAsStepScript(t, `${prologue}\necho PROLOGUE_DONE`, {
    RUNNER_TEMP: directory,
    GITHUB_RUN_ID: '12345',
    GITHUB_RUN_ATTEMPT: '1',
    SEALOS_NAMESPACE: 'ns-test',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PROLOGUE_DONE/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(sentinel), false,
    'the validated env file content must never be echoed');
});
