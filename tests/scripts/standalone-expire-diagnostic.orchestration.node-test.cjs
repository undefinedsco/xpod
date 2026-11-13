const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  main, repoRoot, requireImmutableImage, renderCompose, verifyConfigReceipt,
  runRepoScript, cleanupOwned, LABEL, PROFILE,
} = require('../../scripts/diagnose-standalone-expire-session.cjs');
const crypto = require('node:crypto');

const IMAGE = `ghcr.io/undefinedsco/xpod@sha256:${'a'.repeat(64)}`;
const SOURCE = 'b'.repeat(40);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * A tiny in-memory Docker + spawn double. It records the exact command order so
 * the REAL `main` orchestration is exercised (not just the pure helpers), while
 * never touching a real daemon or network.
 */
function harness({ derivedTtl = { access: 30, refresh: 5 }, cleanupLeaves = {} } = {}) {
  const calls = [];
  let portUsed;
  // Labels the renderer really wrote into the owned compose file. The fake Docker
  // reads this so its answers track configuration instead of being pre-baked.
  const configuredLabels = new Set();
  const docker = (args, options = {}) => {
    calls.push({ tool: 'docker', args: [...args], cwd: options.cwd });
    if (args[0] === 'compose' && args.includes('up')) {
      const file = args[args.indexOf('-f') + 1];
      try {
        const compose = JSON.parse(fs.readFileSync(file, 'utf8'));
        const collect = (labels) => {
          if (!labels || typeof labels !== 'object') return;
          for (const [key, value] of Object.entries(labels)) configuredLabels.add(`${key}=${value}`);
        };
        for (const service of Object.values(compose.services || {})) collect(service.labels);
        for (const volume of Object.values(compose.volumes || {})) collect(volume.labels);
        for (const network of Object.values(compose.networks || {})) collect(network.labels);
      } catch { /* an unreadable compose file simply yields no owned labels */ }
    }
    if (args[0] === 'pull') return { status: 0, stdout: '' };
    if (args[0] === 'image' && args[1] === 'inspect') {
      return { status: 0, stdout: JSON.stringify([{ Os: 'linux', Architecture: 'amd64',
        RepoDigests: [IMAGE], Id: 'sha256:' + 'c'.repeat(64) }]) };
    }
    if (args[0] === 'create') return { status: 0, stdout: '' };
    if (args[0] === 'cp') {
      // Simulate copying the image's main.json onto disk.
      fs.writeFileSync(args[2], JSON.stringify({ config: 'original' }));
      return { status: 0, stdout: '' };
    }
    if (args[0] === 'rm') return { status: 0, stdout: '' };
    if (args[0] === 'compose') {
      const sub = args[args.indexOf('-f') + 2];
      if (sub === 'ps') return { status: 0, stdout: JSON.stringify({ Health: 'healthy', State: 'running' }) };
      return { status: 0, stdout: '' };
    }
    // Label-aware fake Docker: it answers from the labels the renderer ACTUALLY
    // configured, so a renderer that forgets to label an object yields an empty
    // query naturally instead of being masked by a pre-baked response.
    if (args[0] === 'ps' || args[0] === 'volume' || args[0] === 'network') {
      const filter = args.find((a) => String(a).startsWith('label=')) ?? '';
      const wanted = filter.slice('label='.length);
      const owned = configuredLabels.has(wanted);
      if (!owned) return { status: 0, stdout: '' };
      const kind = args[0] === 'ps' ? 'container' : args[0];
      return { status: 0, stdout: cleanupLeaves[kind] ? `${kind}-leftover` : '' };
    }
    return { status: 0, stdout: '' };
  };
  const spawn = (cmd, argv, options) => {
    calls.push({ tool: 'spawn', cmd, argv: [...argv], cwd: options?.cwd });
    const script = argv[0] ?? '';
    if (script.endsWith('accept-service-image-session.ts') && argv[1] === 'derive-config') {
      const derivedPath = argv[3];
      const receiptPath = argv[5];
      fs.writeFileSync(derivedPath, JSON.stringify({ policy: 'derived', ttl: derivedTtl.access }));
      fs.writeFileSync(receiptPath, JSON.stringify({
        originalConfigSHA256: 'd'.repeat(64),
        derivedConfigSHA256: sha256(fs.readFileSync(derivedPath)),
        accessTokenTtl: derivedTtl.access,
        refreshTokenTtl: derivedTtl.refresh,
      }));
      return { status: 0, stdout: '' };
    }
    if (script.endsWith('accept-service-image-modes.ts')) {
      const accountPath = argv[argv.length - 1];
      fs.writeFileSync(accountPath, JSON.stringify({
        email: 'a@b.c', password: 'p', webId: 'http://localhost:1/profile#me', podUrl: 'http://localhost:1/',
      }));
      return { status: 0, stdout: '' };
    }
    if (script.endsWith('accept-service-image-session.ts') && argv[1] === 'run') {
      const manifest = JSON.parse(fs.readFileSync(argv[2], 'utf8'));
      const out = manifest.outputDirectory;
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'observations.safe.json'), JSON.stringify({ status: 'passed' }));
      fs.writeFileSync(path.join(out, 'lifecycle.safe.json'), JSON.stringify({ exitCode: 0, groupAbsent: true }));
      return { status: 0, stdout: '' };
    }
    return { status: 0, stdout: '' };
  };
  return { docker, spawn, calls, port: 16421 };
}

test('the REAL main orchestration resolves the repo one level up and runs config BEFORE compose up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-main-'));
  const previous = { image: process.env.XPOD_DIAGNOSTIC_IMAGE, sha: process.env.XPOD_DIAGNOSTIC_SOURCE_SHA,
    out: process.env.XPOD_DIAGNOSTIC_OUTPUT };
  process.env.XPOD_DIAGNOSTIC_IMAGE = IMAGE;
  process.env.XPOD_DIAGNOSTIC_SOURCE_SHA = SOURCE;
  process.env.XPOD_DIAGNOSTIC_OUTPUT = dir;
  try {
    // repoRoot must be the checkout root, never its parent.
    assert.equal(repoRoot(path.join(dir, 'scripts')), dir);
    const h = harness();
    const report = await main({ repoRoot: dir, bun: '/usr/local/bin/bun', docker: h.docker,
      spawn: h.spawn, port: 16421, nonce: 'abc123def456', sleep: async () => {} });

    assert.equal(report.status, 'passed',
      `steps=${report.steps.join(',')} errorClass=${report.errorClass} outcome=${report.diagnosticOutcome}`);
    assert.equal(report.kind, 'standalone-expire-diagnostic');
    assert.equal(report.releaseAcceptance, false);
    assert.equal(report.setsRuntimeModeMatrix, false);

    // ORDER: derive-config must precede the first `compose ... up`.
    const deriveIndex = h.calls.findIndex((c) => c.tool === 'spawn' && (c.argv[1] ?? '') === 'derive-config');
    const upIndex = h.calls.findIndex((c) => c.tool === 'docker' && c.args[0] === 'compose' && c.args.includes('up'));
    assert.ok(deriveIndex >= 0, 'derive-config ran');
    assert.ok(upIndex >= 0, 'compose up ran');
    assert.ok(deriveIndex < upIndex, 'config derived BEFORE compose up');

    // EVERY compose call passes the owned -f file and the owned cwd.
    const composeCalls = h.calls.filter((c) => c.tool === 'docker' && c.args[0] === 'compose');
    assert.ok(composeCalls.length >= 3, 'up + ps + down all ran');
    for (const call of composeCalls) {
      assert.ok(call.args.includes('-f'), 'compose call carries -f');
      assert.equal(call.args[call.args.indexOf('-f') + 1], path.join(dir, 'owned-abc123def456', 'compose.json'));
      assert.equal(call.cwd, path.join(dir, 'owned-abc123def456'), 'compose runs in the owned dir');
      assert.equal(call.args[call.args.indexOf('-p') + 1], 'xpod-diag-abc123def456');
    }

    // CHILD SPAWNING uses the Bun executable directly - never `node x`.
    for (const call of h.calls.filter((c) => c.tool === 'spawn')) {
      assert.equal(call.cmd, '/usr/local/bin/bun', 'children run under Bun');
      assert.notEqual(call.argv[0], 'x', 'no npm-style x shim');
      assert.ok(call.argv[0].endsWith('.ts'), 'script path is passed directly');
    }

    // The mounted config is the DERIVED file, read-only, at the image config path.
    const compose = JSON.parse(fs.readFileSync(path.join(dir, 'owned-abc123def456', 'compose.json'), 'utf8'));
    const volumes = compose.services.standalone.volumes;
    const derivedPath = path.join(dir, 'owned-abc123def456', 'main.derived.json');
    assert.ok(volumes.includes(`${derivedPath}:/app/config/main.json:ro`), 'derived config bind-mounted: ' + volumes.join('|'));
    assert.equal(compose.services.standalone.command.includes('--host'), true);
    assert.equal(compose.services.standalone.command[compose.services.standalone.command.indexOf('--host') + 1], '0.0.0.0');
    assert.deepEqual(compose.services.standalone.ports, ['127.0.0.1:16421:16421']);

    // The report records the actual expire policy and both hashes.
    assert.equal(report.config.accessTokenTtl, 30);
    assert.equal(report.config.refreshTokenTtl, 5);
    assert.equal(report.config.mountedAt, '/app/config/main.json');
    assert.equal(report.config.mountMode, 'ro');

    // Cleanup confirmed and the reader container was labelled like everything else.
    assert.equal(report.cleanup.confirmed, true);
    const createCall = h.calls.find((c) => c.tool === 'docker' && c.args[0] === 'create');
    assert.ok(createCall, 'config reader created');
    assert.ok(createCall.args.includes('--label'), 'reader carries an owned label');
    // L1: the reader must carry the EXACT project label cleanup filters on, not a
    // basename-derived id that cleanup would never match.
    assert.ok(createCall.args.includes(`${LABEL}=xpod-diag-abc123def456`),
      `reader label must equal the authoritative project (got ${createCall.args.filter((a) => a.startsWith(LABEL)).join(',')})`);
    const labelArg = createCall.args[createCall.args.indexOf('--label') + 1];
    assert.equal(labelArg, `${LABEL}=xpod-diag-abc123def456`);
  } finally {
    process.env.XPOD_DIAGNOSTIC_IMAGE = previous.image;
    process.env.XPOD_DIAGNOSTIC_SOURCE_SHA = previous.sha;
    process.env.XPOD_DIAGNOSTIC_OUTPUT = previous.out;
    // `main` sets process.exitCode on the failure paths it is meant to exercise;
    // reset it so the test runner itself is not marked failed.
    process.exitCode = 0;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main REFUSES a derived config that is not the expire 30/5 policy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-ttl-'));
  const previous = { image: process.env.XPOD_DIAGNOSTIC_IMAGE, sha: process.env.XPOD_DIAGNOSTIC_SOURCE_SHA,
    out: process.env.XPOD_DIAGNOSTIC_OUTPUT };
  process.env.XPOD_DIAGNOSTIC_IMAGE = IMAGE;
  process.env.XPOD_DIAGNOSTIC_SOURCE_SHA = SOURCE;
  process.env.XPOD_DIAGNOSTIC_OUTPUT = dir;
  try {
    const h = harness({ derivedTtl: { access: 3600, refresh: 1209600 } });
    const report = await main({ repoRoot: dir, bun: '/usr/local/bin/bun', docker: h.docker,
      spawn: h.spawn, port: 16422, nonce: 'aaaabbbbcccc', sleep: async () => {} });
    assert.equal(report.status, 'failed');
    // And it must never have started the service with the wrong TTLs.
    const upIndex = h.calls.findIndex((c) => c.tool === 'docker' && c.args[0] === 'compose' && c.args.includes('up'));
    assert.equal(upIndex, -1, 'compose up never ran with a non-expire policy');
  } finally {
    process.env.XPOD_DIAGNOSTIC_IMAGE = previous.image;
    process.env.XPOD_DIAGNOSTIC_SOURCE_SHA = previous.sha;
    process.env.XPOD_DIAGNOSTIC_OUTPUT = previous.out;
    // `main` sets process.exitCode on the failure paths it is meant to exercise;
    // reset it so the test runner itself is not marked failed.
    process.exitCode = 0;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main FAILS the run when cleanup cannot be confirmed for containers, volume or network', async () => {
  for (const leak of ['container', 'volume', 'network']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `diag-leak-${leak}-`));
    const previous = { image: process.env.XPOD_DIAGNOSTIC_IMAGE, sha: process.env.XPOD_DIAGNOSTIC_SOURCE_SHA,
      out: process.env.XPOD_DIAGNOSTIC_OUTPUT };
    process.env.XPOD_DIAGNOSTIC_IMAGE = IMAGE;
    process.env.XPOD_DIAGNOSTIC_SOURCE_SHA = SOURCE;
    process.env.XPOD_DIAGNOSTIC_OUTPUT = dir;
    try {
      const h = harness({ cleanupLeaves: { [leak]: true } });
      const report = await main({ repoRoot: dir, bun: '/usr/local/bin/bun', docker: h.docker,
        spawn: h.spawn, port: 16423, nonce: '111122223333', sleep: async () => {} });
      assert.equal(report.cleanup.confirmed, false, leak);
      assert.equal(report.status, 'failed', leak);
      assert.equal(report.diagnosticOutcome, 'cleanup-unconfirmed', leak);
    } finally {
      process.env.XPOD_DIAGNOSTIC_IMAGE = previous.image;
      process.env.XPOD_DIAGNOSTIC_SOURCE_SHA = previous.sha;
      process.env.XPOD_DIAGNOSTIC_OUTPUT = previous.out;
      process.exitCode = 0;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('an unobservable cleanup reports unknown flags and never claims confirmed', () => {
  const boom = () => { throw new Error('docker unavailable'); };
  const result = cleanupOwned({ project: 'p', composeFile: '/tmp/x.json', composeCwd: '/tmp', dockerFn: boom });
  assert.equal(result.confirmed, false);
  assert.equal(result.containersUnknown, true);
  assert.equal(result.volumesUnknown, true);
  assert.equal(result.networksUnknown, true);
});

test('runRepoScript passes the Bun executable and the script path directly', () => {
  const seen = [];
  const spawn = (cmd, argv, options) => { seen.push({ cmd, argv, cwd: options.cwd }); return { status: 0 }; };
  runRepoScript({ bun: '/bun', repo: '/repo', script: 'scripts/x.ts', args: ['a'], timeoutMs: 1000, spawn });
  assert.equal(seen[0].cmd, '/bun');
  assert.deepEqual(seen[0].argv, [path.join('/repo', 'scripts/x.ts'), 'a']);
  assert.equal(seen[0].cwd, '/repo');
});

test('image admission is restricted to the exact repository', () => {
  assert.equal(requireImmutableImage(IMAGE), IMAGE);
  assert.throws(() => requireImmutableImage(`ghcr.io/other/xpod@sha256:${'a'.repeat(64)}`), /ghcr\.io\/undefinedsco\/xpod/);
  assert.throws(() => requireImmutableImage('ghcr.io/undefinedsco/xpod:latest'), /ghcr\.io\/undefinedsco\/xpod/);
  assert.throws(() => requireImmutableImage(`${IMAGE}; rm -rf /`), /ghcr\.io\/undefinedsco\/xpod/);
});

test('L2: the default network is labelled with the authoritative project so a leak is detectable', () => {
  const derived = '/owned/main.derived.json';
  const compose = renderCompose({ image: IMAGE, port: 16430, volume: 'xpod-diag-abc-data',
    project: 'xpod-diag-abc', derivedConfigHostPath: derived });
  // The SAME label key/value the cleanup query filters on must be configured on
  // the network, otherwise that query can never return a leftover.
  assert.equal(compose.networks.default.labels[LABEL], 'xpod-diag-abc');
  assert.equal(compose.services.standalone.labels[LABEL], 'xpod-diag-abc');
  assert.equal(compose.volumes['xpod-diag-abc-data'].labels[LABEL], 'xpod-diag-abc');
});

test('L1 negative: a basename label is not the project label, so cleanup cannot see the reader', () => {
  // Reproduces the defect C found: the reader carried `owned-<nonce>` while the
  // cleanup query filters `xpod-diag-<nonce>`. A basename-labelled reader is
  // invisible to the query, which is why the fix passes the authoritative project.
  const nonce = 'abc123def456';
  const project = `xpod-diag-${nonce}`;
  const basenameLabel = 'owned-abc123def456';
  assert.notEqual(`${LABEL}=${basenameLabel}`, `${LABEL}=${project}`);
  assert.ok(!`${LABEL}=${basenameLabel}`.startsWith(`${LABEL}=${project}`),
    'the old basename label must not match the project-filtered query');
  // And the renderer/sub-call now uses the project, proven in the main test below.
});

test('L1: a config reader that survives removal is caught by the project label query', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-reader-leak-'));
  const previous = { image: process.env.XPOD_DIAGNOSTIC_IMAGE, sha: process.env.XPOD_DIAGNOSTIC_SOURCE_SHA,
    out: process.env.XPOD_DIAGNOSTIC_OUTPUT };
  process.env.XPOD_DIAGNOSTIC_IMAGE = IMAGE;
  process.env.XPOD_DIAGNOSTIC_SOURCE_SHA = SOURCE;
  process.env.XPOD_DIAGNOSTIC_OUTPUT = dir;
  try {
    const h = harness();
    // Make `rm` a no-op and keep the reader visible to the label query, which is
    // exactly the failure the old basename label would have hidden.
    const docker = (args, options = {}) => {
      if (args[0] === 'rm') return { status: 0, stdout: '' };
      if (args[0] === 'ps' && args.includes('-aq')) {
        const filter = args.find((a) => String(a).startsWith('label=')) ?? '';
        if (filter === `label=${LABEL}=xpod-diag-feedface`) return { status: 0, stdout: 'reader1' };
        return h.docker(args, options);
      }
      return h.docker(args, options);
    };
    const report = await main({ repoRoot: dir, bun: '/usr/local/bin/bun', docker,
      spawn: h.spawn, port: 16431, nonce: 'feedface', sleep: async () => {} });
    // The reader was never removed AND it carries the queried project label, so
    // the label-based cleanup observation must not claim success.
    assert.equal(report.cleanup.confirmed, false);
    assert.equal(report.status, 'failed');
  } finally {
    process.env.XPOD_DIAGNOSTIC_IMAGE = previous.image;
    process.env.XPOD_DIAGNOSTIC_SOURCE_SHA = previous.sha;
    process.env.XPOD_DIAGNOSTIC_OUTPUT = previous.out;
    process.exitCode = 0;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
