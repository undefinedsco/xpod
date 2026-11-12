#!/usr/bin/env node
/**
 * MANUAL Linux x64 standalone-expire DIAGNOSTIC driver.
 *
 * WHAT THIS IS: a feature-branch-safe reproduction of exactly ONE browser profile
 * (`standalone` + `expire`) against the exact immutable application image, using
 * the EXISTING account-preparation, config-derivation and session-runner scripts.
 *
 * WHAT THIS IS NOT: release acceptance. It never sets `runtime-mode-matrix`
 * passed, never satisfies the candidate 9-profile requirement, and never claims
 * release validity. Its receipt kind `standalone-expire-diagnostic` is not
 * accepted by the release verifier.
 *
 * RUN SHAPE: the workflow invokes this file with **Bun**, and every child is
 * spawned with that same Bun executable directly (`bun <script> <args>`). It never
 * spawns through Node's `x` shim, which would be invalid.
 *
 * SAFETY SHAPE:
 *  - image must be exactly `ghcr.io/undefinedsco/xpod@sha256:<64hex>`;
 *  - every Docker object carries one owned project label and is removed in
 *    `finally`; cleanup is verified for containers, volumes AND networks, and a
 *    failure to verify FAILS the run with `confirmed: false`;
 *  - only an allowlisted safe projection is uploaded - never credentials, URLs,
 *    response bodies or raw logs.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

/** The ONLY admissible application image: exact repository + immutable digest. */
const IMAGE_PATTERN = /^ghcr\.io\/undefinedsco\/xpod@sha256:[a-f0-9]{64}$/;
const PROFILE = Object.freeze({ kind: 'expire', accessTokenTtl: 30, refreshTokenTtl: 5 });
const MODE = 'standalone';
const PLATFORM = 'linux/amd64';
const LABEL = 'co.undefineds.xpod.diagnostic';
const SAFE_PHASES = new Set([
  'preflight', 'storage-verify', 'browser-verify', 'electron-launch', 'login',
  'initial-private-read', 'anonymous-denied', 'renewal', 'post-renew-runtime',
  'restart-launch', 'restart-runtime', 'restart-binding-webid', 'restart-binding-pod',
  'restart-binding-issuer', 'restart-private-read', 'observer-binding',
  'observer-binding-read', 'observer-binding-restart-codes',
  'observer-binding-restart-password', 'observer-binding-global-counts',
  'final-private-read', 'cleanup-final',
]);
const SAFE_REASONS = new Set(['assertion-failed', 'approval-timed-out', 'launch-failed']);
const COUNTER_MAX = 10_000;

function fail(message) {
  const error = new Error(message);
  error.diagnosticFailure = true;
  throw error;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** The repository root: this file lives at <root>/scripts/. */
function repoRoot(dirname) {
  // Exactly ONE parent: <root>/scripts -> <root>. Two would escape the checkout.
  return path.resolve(dirname, '..');
}

/** Strict immutable-image admission; only surrounding whitespace is trimmed. */
function requireImmutableImage(value) {
  const image = String(value ?? '').trim();
  if (!IMAGE_PATTERN.test(image)) fail('Diagnostic image must be ghcr.io/undefinedsco/xpod@sha256:<64hex>');
  return image;
}

function ownedNonce() {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * The toolchain every child must use. The workflow runs this file under Bun, so
 * `process.versions.bun` is set and `process.execPath` IS the Bun binary. Spawning
 * `process.execPath` with an `x --no-install` shim would be invalid, so callers
 * pass the script path and args directly.
 */
function requireBunRuntime() {
  if (!process.versions.bun) {
    fail('Diagnostic must run under Bun (the workflow invokes it with bun)');
  }
  return process.execPath;
}

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    cwd: options.cwd,
    timeout: options.timeoutMs ?? 600_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error && options.allowFailure !== true) fail(`docker ${args[0]} unavailable`);
  if (options.allowFailure !== true && result.status !== 0) fail(`docker ${args[0]} failed`);
  return result;
}

function freePort() {
  // Ask the OS for an unused loopback port in a throwaway child, so the port is
  // not still held by this process when Docker binds it.
  const probe = spawnSync(process.execPath, ['-e', [
    "const net=require('node:net');",
    "const s=net.createServer();",
    "s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});",
  ].join('')], { encoding: 'utf8' });
  if (probe.status !== 0) fail('Could not reserve a loopback port');
  const value = Number(probe.stdout.trim());
  if (!Number.isSafeInteger(value) || value <= 0 || value === 60895) fail('Invalid reserved port');
  return value;
}

function writePrivate(filename, contents) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filename, contents, { mode: 0o600, flag: 'wx' });
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function boundedCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= COUNTER_MAX ? value : 0;
}

function absentObserver() {
  return { present: 0, authorizationCodes: 0, passwordPosts: 0, refreshTokens: 0,
    opaquePosts: 0, ready: 0, hostImported: 0, failed: 0 };
}

function absentFailure() {
  return { present: 0, phase: 'preflight', reason: 'assertion-failed',
    authorizationCodes: 0, passwordPosts: 0, refreshGrants: 0, refreshFailures: 0,
    requestCount: 0, restartObserver: absentObserver() };
}

/**
 * Project a failure.safe.json into the closed safe shape. Unknown phases/reasons
 * collapse, counters clamp, every foreign key is dropped.
 *
 * The restart observer is retained as soon as a PARSEABLE record exists, so a
 * record whose flags are bad still reports `present: 1` with its actual
 * counters/flags. Only a missing or unparsable file reports `present: 0`.
 */
function safeFailureProjection(filename) {
  if (!fs.existsSync(filename)) return absentFailure();
  let raw;
  try { raw = readJson(filename); } catch { return absentFailure(); }
  const diagnostic = raw && raw.diagnostic;
  if (!diagnostic || typeof diagnostic !== 'object') return absentFailure();
  const observer = diagnostic.restartObserver && typeof diagnostic.restartObserver === 'object'
    ? diagnostic.restartObserver : undefined;
  return {
    present: 1,
    phase: SAFE_PHASES.has(diagnostic.phase) ? diagnostic.phase : 'preflight',
    reason: SAFE_REASONS.has(diagnostic.reason) ? diagnostic.reason : 'assertion-failed',
    authorizationCodes: boundedCounter(diagnostic.authorizationCodes),
    passwordPosts: boundedCounter(diagnostic.passwordPosts),
    refreshGrants: boundedCounter(diagnostic.refreshGrants),
    refreshFailures: boundedCounter(diagnostic.refreshFailures),
    requestCount: boundedCounter(diagnostic.requestCount),
    restartObserver: observer ? {
      present: boundedCounter(observer.present),
      authorizationCodes: boundedCounter(observer.authorizationCodes),
      passwordPosts: boundedCounter(observer.passwordPosts),
      refreshTokens: boundedCounter(observer.refreshTokens),
      opaquePosts: boundedCounter(observer.opaquePosts),
      ready: boundedCounter(observer.ready),
      hostImported: boundedCounter(observer.hostImported),
      failed: boundedCounter(observer.failed),
    } : absentObserver(),
  };
}

/** Allowlisted lifecycle booleans only; exit code normalized to 0|1. */
function safeLifecycleProjection(filename) {
  if (!fs.existsSync(filename)) return { present: 0 };
  let raw;
  try { raw = readJson(filename); } catch { return { present: 0 }; }
  const flag = (value) => value === true;
  const code = Number.isSafeInteger(raw.exitCode) ? raw.exitCode : raw.code;
  return {
    present: 1,
    exitCode: code === 0 ? 0 : 1,
    timedOut: flag(raw.timedOut),
    cancelled: flag(raw.cancelled),
    forcedCleanup: flag(raw.forcedCleanup),
    outputTruncated: flag(raw.outputTruncated),
    spawnFailed: flag(raw.spawnFailed),
    ownershipUnknown: flag(raw.ownershipUnknown),
    groupAbsent: flag(raw.groupAbsent),
  };
}

/**
 * Compose file for EXACTLY ONE standalone service.
 *
 * The container MUST listen on 0.0.0.0: Docker publishes the host port into the
 * container's interface, and a 127.0.0.1 bind inside the container is unreachable
 * from the host. The published host address stays loopback-only.
 *
 * The derived expire config is bind-mounted read-only over the image's own config
 * path, exactly like the existing multi-mode matrix, so the server really runs
 * with the shortened TTLs instead of merely being labelled with them.
 */
function renderCompose({ image, port, volume, project, derivedConfigHostPath }) {
  return {
    services: {
      standalone: {
        image,
        platform: PLATFORM,
        command: ['bun', '--no-env-file', 'dist/runtime/service-entry.js', 'start',
          '--mode', 'local', '--port', String(port), '--host', '0.0.0.0'],
        environment: {
          XPOD_EDITION: 'local',
          XPOD_NODE_ID: `diagnostic-standalone-${project}`,
          XPOD_PORT: String(port),
          CSS_BASE_URL: `http://localhost:${port}/`,
          SOLID_OIDC_ISSUER: `http://localhost:${port}/`,
          CSS_IDENTITY_DB_URL: 'sqlite:/app/data/identity.sqlite',
          CSS_SPARQL_ENDPOINT: 'sqlite:/app/data/rdf.sqlite',
          CSS_LOGGING_LEVEL: 'info',
          XPOD_RDF_NATIVE_SPARQL_ENABLED: 'false',
        },
        ports: [`127.0.0.1:${port}:${port}`],
        healthcheck: {
          test: ['CMD', 'curl', '--fail', '--silent', `http://127.0.0.1:${port}/.well-known/openid-configuration`],
          interval: '5s', timeout: '5s', retries: 40,
        },
        volumes: [`${volume}:/app/data`, `${derivedConfigHostPath}:/app/config/main.json:ro`],
        labels: { [LABEL]: project },
      },
    },
    // Compose creates one default network per project. Label it too, otherwise the
    // cleanup network query (which filters this same label) always returns empty
    // and a leaked network could never be detected.
    networks: { default: { labels: { [LABEL]: project } } },
    volumes: { [volume]: { labels: { [LABEL]: project } } },
  };
}

/** Every compose invocation passes the SAME owned file and cwd, no exceptions. */
function composeCall({ project, composeFile, composeCwd, args, options = {}, dockerFn = docker }) {
  return dockerFn(['compose', '-p', project, '-f', composeFile, ...args], { cwd: composeCwd, ...options });
}

async function waitHealthy({ project, composeFile, composeCwd, service, deadlineMs, sleep, dockerFn = docker }) {
  const pause = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  while (Date.now() < deadlineMs) {
    const result = composeCall({ project, composeFile, composeCwd, dockerFn,
      args: ['ps', '--format', 'json', service], options: { allowFailure: true } });
    if (result.status === 0 && result.stdout.trim()) {
      let row;
      try { row = JSON.parse(result.stdout.trim().split('\n').pop()); } catch { row = undefined; }
      if (row && row.Health === 'healthy') return true;
      if (row && row.State === 'exited') return false;
    }
    await pause(3000);
  }
  return false;
}

/** Run an EXISTING repo script with the SAME Bun toolchain. No `node x` shim. */
function runRepoScript({ bun, repo, script, args, timeoutMs, spawn = spawnSync }) {
  return spawn(bun, [path.join(repo, script), ...args], {
    cwd: repo, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 20,
  });
}

/**
 * Derive the expire config from the image's own main.json BEFORE any service
 * container starts, so the derived file can be mounted at compose-up time.
 */
function deriveProfileConfig({ bun, repo, image, workRoot, project, dockerFn, spawn }) {
  const containerMain = path.join(workRoot, 'main.original.json');
  const copyName = `cfg-reader-${path.basename(workRoot)}`;
  // `project` is the AUTHORITATIVE ownership id (the same value compose uses and
  // cleanup filters on). It must NOT be re-derived from a path basename here, or
  // the reader would carry a label cleanup never queries and could leak while the
  // run still reported confirmed cleanup.
  if (typeof project !== 'string' || !project.trim()) fail('Config reader requires the owned project label');
  dockerFn(['create', '--label', `${LABEL}=${project}`, '--name', copyName, image]);
  try {
    dockerFn(['cp', `${copyName}:/app/config/main.json`, containerMain]);
  } finally {
    dockerFn(['rm', '-f', '-v', copyName], { allowFailure: true });
    // allowFailure stays permitted (a racing/absent container is harmless), but the
    // removal is VERIFIED: if the reader is still present it carries our project
    // label, so cleanup's container query would catch it and report unconfirmed.
    const remaining = dockerFn(['ps', '-aq', '--filter', `label=${LABEL}=${project}`], { allowFailure: true });
    if (remaining && remaining.status === 0 && String(remaining.stdout || '').trim()) {
      fail('Owned config reader container could not be removed');
    }
  }
  const derivedConfig = path.join(workRoot, 'main.derived.json');
  const receipt = path.join(workRoot, 'config-receipt.json');
  const result = runRepoScript({ bun, repo, script: 'scripts/accept-service-image-session.ts',
    args: ['derive-config', containerMain, derivedConfig, PROFILE.kind, receipt],
    timeoutMs: 300_000, spawn });
  if (!result || result.status !== 0) fail('Config derivation failed');
  return { containerMain, derivedConfig, receipt, copyName };
}

/** Assert the receipt really carries the expire policy and both config hashes. */
function verifyConfigReceipt(receiptPath, derivedConfigPath) {
  const row = readJson(receiptPath);
  if (row.accessTokenTtl !== PROFILE.accessTokenTtl || row.refreshTokenTtl !== PROFILE.refreshTokenTtl) {
    fail('Derived config receipt is not the expire 30/5 policy');
  }
  if (!/^[a-f0-9]{64}$/.test(String(row.originalConfigSHA256 ?? ''))
    || !/^[a-f0-9]{64}$/.test(String(row.derivedConfigSHA256 ?? ''))) {
    fail('Derived config receipt must bind both config hashes');
  }
  const actual = sha256(fs.readFileSync(derivedConfigPath));
  if (actual !== row.derivedConfigSHA256) fail('Derived config bytes do not match the receipt hash');
  return row;
}

function requireSha(value) {
  const text = String(value ?? '').trim();
  if (!/^[a-f0-9]{40}$/.test(text)) fail('Diagnostic source SHA must be 40 hex characters');
  return text;
}

/**
 * Remove ONLY our own labelled resources, then VERIFY container, volume and
 * network are gone. Unobservable state is reported as unknown, never confirmed.
 */
function cleanupOwned({ project, composeFile, composeCwd, dockerFn = docker }) {
  try {
    composeCall({ project, composeFile, composeCwd, dockerFn, args: ['down', '-v', '--remove-orphans'],
      options: { allowFailure: true, timeoutMs: 300_000 } });
  } catch { /* observability handled below */ }

  const observe = (args) => {
    try {
      const result = dockerFn(args, { allowFailure: true });
      if (!result || result.status !== 0 || result.error) return 'unknown';
      return result.stdout.trim();
    } catch { return 'unknown'; }
  };

  const containers = observe(['ps', '-aq', '--filter', `label=${LABEL}=${project}`]);
  const volumes = observe(['volume', 'ls', '-q', '--filter', `label=${LABEL}=${project}`]);
  const networks = observe(['network', 'ls', '-q', '--filter', `label=${LABEL}=${project}`]);
  const clean = (value) => value === '';
  return {
    confirmed: clean(containers) && clean(volumes) && clean(networks),
    containersRemaining: clean(containers) ? 0 : 1,
    volumesRemaining: clean(volumes) ? 0 : 1,
    networksRemaining: clean(networks) ? 0 : 1,
    containersUnknown: containers === 'unknown',
    volumesUnknown: volumes === 'unknown',
    networksUnknown: networks === 'unknown',
  };
}

async function main(deps = {}) {
  const root = deps.repoRoot ?? repoRoot(__dirname);
  const bun = deps.bun ?? requireBunRuntime();
  const image = requireImmutableImage(process.env.XPOD_DIAGNOSTIC_IMAGE);
  const sourceSha = requireSha(process.env.XPOD_DIAGNOSTIC_SOURCE_SHA);
  const output = path.resolve(process.env.XPOD_DIAGNOSTIC_OUTPUT ?? path.join(root, '.test-data', 'standalone-expire-diagnostic'));
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });

  const nonce = deps.nonce ?? ownedNonce();
  const project = `xpod-diag-${nonce}`;
  const volume = `xpod-diag-${nonce}-data`;
  const workRoot = path.join(output, `owned-${nonce}`);
  const composeFile = path.join(workRoot, 'compose.json');
  const accountFile = path.join(workRoot, 'account.json');
  const sessionManifest = path.join(workRoot, 'session.json');
  const sessionOutput = path.join(workRoot, 'session-output');
  fs.mkdirSync(workRoot, { recursive: true, mode: 0o700 });

  const dockerFn = deps.docker ?? docker;
  const spawn = deps.spawn;
  const report = {
    schemaVersion: 1,
    kind: 'standalone-expire-diagnostic',
    diagnosticOnly: true,
    releaseAcceptance: false,
    setsRuntimeModeMatrix: false,
    sourceSha,
    image: { reference: image, platform: PLATFORM },
    profile: { ...PROFILE },
    mode: MODE,
    project,
    steps: [],
    cleanup: { confirmed: false },
  };
  const step = (name) => { report.steps.push(name); };
  let failureCode;
  const composeCwd = workRoot;

  try {
    step('image-pull');
    dockerFn(['pull', '--platform', PLATFORM, image], { timeoutMs: 1_800_000 });
    const inspected = JSON.parse(dockerFn(['image', 'inspect', image]).stdout)[0];
    if (`${inspected.Os}/${inspected.Architecture}` !== PLATFORM) fail('Image platform mismatch');
    if (!Array.isArray(inspected.RepoDigests) || !inspected.RepoDigests.includes(image)) fail('Image digest identity mismatch');
    report.image.id = inspected.Id;

    // ---- config FIRST: derive from the image, verify 30/5, THEN mount it ----
    step('derive-config');
    const config = deriveProfileConfig({ bun, repo: root, image, workRoot, project, dockerFn, spawn });
    const receipt = verifyConfigReceipt(config.receipt, config.derivedConfig);
    report.config = {
      accessTokenTtl: receipt.accessTokenTtl,
      refreshTokenTtl: receipt.refreshTokenTtl,
      originalConfigSHA256: receipt.originalConfigSHA256,
      derivedConfigSHA256: receipt.derivedConfigSHA256,
      derivedBytes: fs.statSync(config.derivedConfig).size,
      mountedAt: '/app/config/main.json',
      mountMode: 'ro',
    };

    // ---- owned compose up (config already available to mount) --------------
    const port = deps.port ?? freePort();
    report.port = port;
    writePrivate(composeFile, `${JSON.stringify(renderCompose({
      image, port, volume, project, derivedConfigHostPath: config.derivedConfig,
    }), null, 2)}\n`);
    step('compose-up');
    composeCall({ project, composeFile, composeCwd, dockerFn, args: ['up', '-d'], options: { timeoutMs: 600_000 } });
    const healthy = await waitHealthy({ project, composeFile, composeCwd, dockerFn, service: 'standalone',
      deadlineMs: Date.now() + 180_000, sleep: deps.sleep });
    if (!healthy) fail('Owned standalone service did not become healthy');

    // ---- normal HTTP account creation (EXISTING script) --------------------
    step('prepare-account');
    const baseUrl = `http://localhost:${port}/`;
    const accountInput = path.join(workRoot, 'account-input.json');
    writePrivate(accountInput, `${JSON.stringify({ mode: MODE, kind: PROFILE.kind, urls: { [MODE]: baseUrl } }, null, 2)}\n`);
    const prepared = runRepoScript({ bun, repo: root, script: 'scripts/accept-service-image-modes.ts',
      args: ['prepare-account', accountInput, accountFile], timeoutMs: 300_000, spawn });
    if (prepared.status !== 0) fail('Account preparation failed');
    const account = readJson(accountFile);

    // ---- session manifest + EXISTING runner -------------------------------
    step('session-run');
    writePrivate(sessionManifest, `${JSON.stringify({
      schemaVersion: 1,
      sourceSha,
      mode: MODE,
      baseUrl,
      issuer: baseUrl,
      image: { reference: image, platform: PLATFORM, id: inspected.Id },
      profile: {
        kind: PROFILE.kind,
        accessTokenTtl: PROFILE.accessTokenTtl,
        refreshTokenTtl: PROFILE.refreshTokenTtl,
        originalConfigSHA256: receipt.originalConfigSHA256,
        derivedConfigSHA256: receipt.derivedConfigSHA256,
      },
      binding: { webId: account.webId, podUrl: account.podUrl },
      ownershipRoot: workRoot,
      accountFile,
      outputDirectory: sessionOutput,
    }, null, 2)}\n`);
    const session = runRepoScript({ bun, repo: root, script: 'scripts/accept-service-image-session.ts',
      args: ['run', sessionManifest], timeoutMs: 900_000, spawn });
    report.sessionExit = session.status === 0 ? 0 : 1;

    report.failure = safeFailureProjection(path.join(sessionOutput, 'failure.safe.json'));
    report.lifecycle = safeLifecycleProjection(path.join(sessionOutput, 'lifecycle.safe.json'));
    report.observations = fs.existsSync(path.join(sessionOutput, 'observations.safe.json'))
      ? { present: 1, sha256: sha256(fs.readFileSync(path.join(sessionOutput, 'observations.safe.json'))) }
      : { present: 0 };
    if (report.sessionExit !== 0) failureCode = 'session-failed';
  } catch (error) {
    failureCode = error && error.diagnosticFailure ? 'diagnostic-error' : 'unexpected-error';
    report.errorClass = failureCode;
    // Value-free: the message is one of this file's own fixed strings.
    report.errorMessage = error && typeof error.message === 'string' ? error.message : 'unknown';
  } finally {
    try {
      report.cleanup = cleanupOwned({ project, composeFile, composeCwd, dockerFn });
    } catch {
      report.cleanup = { confirmed: false, containersUnknown: true, volumesUnknown: true, networksUnknown: true };
    }
    if (report.cleanup.confirmed !== true) failureCode = failureCode ?? 'cleanup-unconfirmed';
  }

  report.status = failureCode ? 'failed' : 'passed';
  report.diagnosticOutcome = failureCode ?? 'passed';
  writePrivate(path.join(output, 'diagnostic.report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (failureCode) {
    console.error(`[standalone-expire-diagnostic] ${failureCode} (safe report written)`);
    process.exitCode = 1;
  } else {
    console.log('[standalone-expire-diagnostic] passed (diagnostic only; NOT release acceptance)');
  }
  return report;
}

module.exports = {
  IMAGE_PATTERN, PROFILE, LABEL, SAFE_PHASES, SAFE_REASONS,
  requireImmutableImage, safeFailureProjection, safeLifecycleProjection,
  renderCompose, ownedNonce, repoRoot, requireBunRuntime, verifyConfigReceipt,
  composeCall, cleanupOwned, runRepoScript, deriveProfileConfig, main,
  absentObserver, boundedCounter,
};

if ((require.main === module) || (process.versions.bun && process.argv[1] && path.resolve(process.argv[1]) === __filename)) {
  main().catch(() => {
    console.error('[standalone-expire-diagnostic] unexpected failure');
    process.exitCode = 1;
  });
}
