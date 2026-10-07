#!/usr/bin/env node
/** Verify safe, exact-artifact evidence from real packaged desktop permission operations.
 * This supplements self-update evidence; neither record can replace the other.
 * No public record may contain arbitrary diagnostics, URLs or authentication state.
 */
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');

const SHA256 = /^[a-f0-9]{64}$/;
const SHA512 = /^[A-Za-z0-9+/]{86}==$/;
const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-rc\.\d+(?:\.\d+)?)?$/;
const trueValue = value => value === true;
const hash = value => typeof value === 'string' && SHA256.test(value);
const zero = value => value === 0;

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
    runtime: { version: s => s === expected?.version, edition: s => s === 'local',
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

async function bundledRuntimeHash(archive) {
  const child = spawn('unzip', ['-p', archive, 'Xpod.app/Contents/Resources/runtime/xpod'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Missing archive runtime')));
  });
  // Attach the rejection handler before consuming a possibly empty stdout.
  const outcome = completion.then(() => undefined, () => new Error('Missing archive runtime'));
  const sha256 = createHash('sha256');
  for await (const chunk of child.stdout) sha256.update(chunk);
  const failure = await outcome;
  if (failure) throw failure;
  return sha256.digest('hex');
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
  const result = verifyEvidence(record, { sourceSha: args['--source-sha'], version: args['--version'],
    archive: await describeArchive(args['--expected-archive']),
    runtimeBinarySha256: await bundledRuntimeHash(args['--expected-archive']), resourceIds: AI_CONNECTIONS_SERVICE_RESOURCE_IDS });
  if (args['--checks-out'] && result.valid) {
    // A distinct check is merged with verified self-update by the workflow;
    // this verifier must never independently set the mandatory desktop check.
    fs.writeFileSync(args['--checks-out'], JSON.stringify({ 'desktop-permissions': 'passed' }) + '\n');
  }
  console.log(JSON.stringify(result));
  return result.valid ? 0 : 1;
}

module.exports = { verifyEvidence, describeArchive, bundledRuntimeHash };
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; })
  .catch(() => { console.error('desktop permission evidence verification failed'); process.exitCode = 1; });
