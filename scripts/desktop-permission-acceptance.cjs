#!/usr/bin/env node
/** Verify safe, exact-artifact evidence from real packaged desktop permission operations.
 * This supplements self-update evidence; neither record can replace the other.
 * No public record may contain arbitrary diagnostics, URLs or authentication state.
 *
 * TWO distinct versions, never interchangeable:
 *   record.version        — the DESKTOP candidate (CFBundleShortVersionString), e.g. 0.4.31-rc.410
 *   record.runtime.version — the BUNDLED LAUNCHER CLI version (`xpod --version`), which is
 *                            the packaged `@undefineds.co/xpod-cli` package version, e.g.
 *                            0.1.0-preview.2. The CLI is versioned independently; the product
 *                            runtime manager never compares it to the desktop candidate.
 * Each is checked against its OWN independent authority read from the same input
 * archive, never against the other and never against the observed value itself.
 */
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');

const path = require('node:path');

const SHA256 = /^[a-f0-9]{64}$/;
const SHA512 = /^[A-Za-z0-9+/]{86}==$/;
const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-rc\.\d+(?:\.\d+)?)?$/;
// The packaged CLI uses its own release line (`0.1.0-preview.N`), so it needs its
// own strict pattern; it is NOT the desktop-candidate shape and must not be
// validated against VERSION.
const CLI_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const trueValue = value => value === true;
const hash = value => typeof value === 'string' && SHA256.test(value);
const zero = value => value === 0;
// Shared with the producer: one metadata helper owns the packaged-runtime layout.
const ARCHIVE_RUNTIME_HELPER = path.join(__dirname, 'lib', 'desktop-archive-runtime.ts');

function verifyEvidence(record, expected) {
  const errors = [];
  function error(path, message = 'required observation is missing or inconsistent') { errors.push({ path, message }); }
  function shape(value, fields, prefix) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) { error(prefix); return; }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(fields, key)) error(prefix ? `${prefix}.[undeclared]` : '[undeclared]', 'undeclared public evidence field');
    }
    for (const [key, validator] of Object.entries(fields)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof validator === 'function') {
        if (!validator(value[key])) error(path);
      } else shape(value[key], validator, path);
    }
  }
  const targetCount = expected?.resourceIds?.length;
  const resourceSet = value => Array.isArray(value) && value.length === targetCount
    && new Set(value).size === targetCount && value.every(id => expected.resourceIds.includes(id));
  const podShape = {
    bindingSha256: hash, webIdSha256: hash, selectedInUi: trueValue,
    first: { resourceIds: resourceSet, fresh: trueValue, granted: n => n === targetCount,
      readBack: n => n === targetCount, parentUnchanged: trueValue },
    repeat: { readBack: n => n === targetCount, acrWrites: zero, sameSession: trueValue },
    management: { configuration: trueValue, models: trueValue, quota: trueValue },
  };
  shape(record, {
    schemaVersion: n => n === 1, kind: s => s === 'desktop-permission-acceptance', ok: trueValue,
    sourceSha: s => typeof s === 'string' && SHA.test(s) && s === expected?.sourceSha,
    version: s => typeof s === 'string' && VERSION.test(s) && s === expected?.version,
    archive: { size: n => Number.isSafeInteger(n) && n > 0 && n === expected?.archive?.size,
      sha256: s => hash(s) && s === expected?.archive?.sha256,
      sha512: s => typeof s === 'string' && SHA512.test(s) && s === expected?.archive?.sha512 },
    runtime: { version: s => typeof s === 'string' && CLI_VERSION.test(s) && s === expected?.cliVersion, edition: s => s === 'local',
      ownership: s => s === 'desktop', binarySha256: s => hash(s) && s === expected?.runtimeBinarySha256, bundled: trueValue, installed: trueValue,
      noExternalOverride: trueValue, freshEndpoint: trueValue },
    identity: { cloudCard: trueValue, independentWebIds: trueValue, independentStorage: trueValue,
      noPublicRoute: trueValue, browserCallback: trueValue },
    pods: value => {
      if (!Array.isArray(value) || value.length !== 2) return false;
      value.forEach((pod, index) => shape(pod, podShape, `pods.${index}`));
      return value[0]?.bindingSha256 !== value[1]?.bindingSha256
        && value[0]?.webIdSha256 !== value[1]?.webIdSha256;
    },
    operations: { accountActor: trueValue, keyCreate: trueValue, keyList: trueValue, keyRevoke: trueValue,
      collectionConfirmed: trueValue, conflictCount: zero, chatStatus: n => n === 200,
      chatBodyMatches: trueValue, chatDispatches: n => n === 1,
      samePodReuse: trueValue, crossPodRejected: trueValue, isolatedRows: trueValue, oldRunRejected: trueValue },
    cleanup: { appStopped: trueValue, runtimeStopped: trueValue, ownedDataRemoved: trueValue,
      providerRemoved: trueValue, keyRemoved: trueValue, attributedGrantsRestored: trueValue, remainingOwnedPids: zero },
    completedAt: s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)
      && Number.isFinite(Date.parse(s)),
  }, '');
  if (!Number.isSafeInteger(targetCount) || targetCount < 1 || new Set(expected.resourceIds).size !== targetCount) {
    error('expected.resourceIds', 'authoritative resource declaration is required');
  }
  return { valid: errors.length === 0, errors };
}

async function describeArchive(file) {
  const sha256 = createHash('sha256');
  const sha512 = createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) { sha256.update(chunk); sha512.update(chunk); }
  return { size: fs.statSync(file).size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') };
}

/**
 * sha256 of the ACTUAL bundled launcher the product resolver selects for this
 * archive (today `runtime/bin/bun`). The member is chosen by the shared
 * archive-runtime metadata helper, so the layout stays derived from the product
 * resolver rather than hardcoded here. Never reads `runtime/xpod`, which the
 * published bundle does not contain.
 */
async function bundledRuntimeHash(archive) {
  return (await readArchiveRuntime(archive)).launcherSha256;
}

/**
 * The single loader for the shared metadata helper.
 *
 * The helper is TypeScript because it imports the product's own pure launch
 * resolver; the verifiers here are CJS and are also invoked by plain `node`
 * outside a build step. The declared Bun toolchain (already required by the
 * desktop job and by this repo's conventions) runs the helper once and returns
 * a small JSON record. No archive code is executed either way.
 */
function readArchiveRuntime(archive) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = message => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };
    const child = spawn('bun', [ARCHIVE_RUNTIME_HELPER, archive], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    let stderr = '';
    // A spawn failure must not leave a live child or a dangling rejection.
    child.once('error', () => fail('Archive runtime helper could not start'));
    child.stderr.on('data', chunk => { if (stderr.length < 2048) stderr += chunk.toString('utf8'); });
    child.stdout.on('data', chunk => {
      if (settled) return;
      chunks.push(chunk);
      size += chunk.length;
      if (size > 64 * 1024) {
        child.kill();
        fail('Archive runtime helper output exceeded bound');
      }
    });
    child.once('close', code => {
      if (settled) return;
      if (code !== 0) {
        // The helper publishes only rule/member-level reasons, so the last line
        // is safe to surface and keeps a rejection diagnosable.
        const lastLine = stderr.trim().split('\n').filter(Boolean).pop() ?? '';
        const reason = /^[A-Za-z0-9 ,'()@/._-]{0,120}$/u.exec(lastLine);
        fail(reason && reason[0] ? reason[0] : 'Missing archive runtime');
        return;
      }
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('Archive runtime helper output invalid'); return; }
      if (!parsed || typeof parsed !== 'object' || !hash(parsed.launcherSha256)
        || typeof parsed.cliVersion !== 'string' || !CLI_VERSION.test(parsed.cliVersion)) {
        fail('Missing archive runtime');
        return;
      }
      settled = true;
      resolve(parsed);
    });
  });
}

async function main(argv) {
  const args = {};
  const allowed = new Set(['--evidence', '--source-sha', '--version', '--expected-archive', '--checks-out']);
  for (let i = 0; i < argv.length; i += 2) {
    if (!allowed.has(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--') || Object.hasOwn(args, argv[i])) {
      throw new Error('invalid verifier arguments');
    }
    args[argv[i]] = argv[i + 1];
  }
  for (const key of ['--evidence', '--source-sha', '--version', '--expected-archive']) {
    if (!args[key]) throw new Error('missing required verifier argument');
  }
  const { AI_CONNECTIONS_SERVICE_RESOURCE_IDS } = require('@undefineds.co/ai-connections/service-access-resources');
  const record = JSON.parse(fs.readFileSync(args['--evidence'], 'utf8'));
  const archive = await describeArchive(args['--expected-archive']);
  // Independent authorities, both from the same input archive: the desktop
  // candidate comes from the declared --version, the launcher CLI version from
  // the archive's own packaged CLI manifest.
  const runtime = await readArchiveRuntime(args['--expected-archive']);
  if (runtime.desktopVersion !== undefined && runtime.desktopVersion !== args['--version']) {
    throw new Error('desktop archive version differs from the declared candidate');
  }
  const result = verifyEvidence(record, { sourceSha: args['--source-sha'], version: args['--version'],
    cliVersion: runtime.cliVersion, archive,
    runtimeBinarySha256: runtime.launcherSha256, resourceIds: AI_CONNECTIONS_SERVICE_RESOURCE_IDS });
  if (args['--checks-out'] && result.valid) {
    // A distinct check is merged with verified self-update by the workflow;
    // this verifier must never independently set the mandatory desktop check.
    fs.writeFileSync(args['--checks-out'], JSON.stringify({ 'desktop-permissions': 'passed' }) + '\n');
  }
  console.log(JSON.stringify(result));
  return result.valid ? 0 : 1;
}

module.exports = { verifyEvidence, describeArchive, bundledRuntimeHash, readArchiveRuntime };
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; })
  .catch(() => { console.error('desktop permission evidence verification failed'); process.exitCode = 1; });
