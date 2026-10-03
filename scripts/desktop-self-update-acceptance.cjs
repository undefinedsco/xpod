#!/usr/bin/env node
/**
 * Verify the machine-readable evidence written by
 * `desktop/scripts/packaged-update-acceptance.mjs`.
 *
 * A green `desktop` acceptance check must be bound to the exact source commit
 * and prove the real old-package -> new-package path actually ran: manifest
 * checked, archive downloaded and checksum-verified, bundle swapped, app
 * relaunched as the newer version, and every owned process/userData released.
 * Bundle presence alone is not evidence.
 *
 * Usage:
 *   node scripts/desktop-self-update-acceptance.cjs verify \
 *     --evidence <file> --source-sha <40-hex> --new-version <candidate> \
 *     [--expected-new-zip <candidate zip>] [--checks-out <file>]
 *
 * `--expected-new-zip` is the byte-level binding: the verifier hashes the file
 * the promotion actually carries and requires it to equal `evidence.newZip`.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const KIND = 'desktop-self-update-acceptance';
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SHA512_BASE64_PATTERN = /^[A-Za-z0-9+/]{86}==$/;
const SENSITIVE_FIELD_PATTERN = /(?:secret|token|password|credential|api[-_]?key)/i;
const REQUIRED_EVENTS = [
  'checking-for-update',
  'update-available',
  'download-verified',
  'update-downloaded',
  'auto-install-ready',
];
const MAX_TRAVERSAL_DEPTH = 16;
const MAX_TRAVERSAL_NODES = 500;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function scanSensitiveFields(value, errors, path = '') {
  const seen = new WeakSet();
  const stack = [{ value, path, depth: 0 }];
  let visitedNodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || (!isPlainObject(current.value) && !Array.isArray(current.value))) continue;
    if (seen.has(current.value)) {
      errors.push({ path: current.path, message: 'cyclic object reference is not allowed' });
      continue;
    }
    seen.add(current.value);
    visitedNodes += 1;
    if (visitedNodes > MAX_TRAVERSAL_NODES) {
      errors.push({ path: current.path, message: 'maximum traversal nodes exceeded' });
      continue;
    }
    if (current.depth > MAX_TRAVERSAL_DEPTH) {
      errors.push({ path: current.path, message: 'maximum traversal depth exceeded' });
      continue;
    }
    const entries = Array.isArray(current.value)
      ? current.value.map((item, index) => [ String(index), item ])
      : Object.entries(current.value);
    for (const [ key, childValue ] of entries) {
      const childPath = current.path ? `${current.path}.${key}` : key;
      if (SENSITIVE_FIELD_PATTERN.test(key)) {
        errors.push({ path: childPath, message: 'sensitive fields are not allowed' });
      }
      stack.push({ value: childValue, path: childPath, depth: current.depth + 1 });
    }
  }
}

function compareVersions(left, right) {
  const parse = (value) => {
    const normalized = String(value ?? '').trim().replace(/^v/, '');
    const [, core = '', prerelease = ''] = normalized.match(/^(\d+(?:\.\d+)*)(?:[-+](.*))?$/) ?? [];
    return {
      numbers: core.split('.').map((part) => Number(part) || 0),
      prerelease: prerelease.split('.').filter(Boolean),
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length); index += 1) {
    const delta = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function verifyEvidence(evidence, expected) {
  const errors = [];
  if (!isPlainObject(evidence)) {
    return { valid: false, errors: [{ path: '', message: 'evidence must be a JSON object' }] };
  }

  scanSensitiveFields(evidence, errors);

  if (evidence.schemaVersion !== 1) errors.push({ path: 'schemaVersion', message: 'schemaVersion must be 1' });
  if (evidence.kind !== KIND) errors.push({ path: 'kind', message: `kind must be ${KIND}` });
  if (evidence.ok !== true) errors.push({ path: 'ok', message: 'acceptance must have completed successfully' });

  if (!SOURCE_SHA_PATTERN.test(String(evidence.sourceSha ?? ''))) {
    errors.push({ path: 'sourceSha', message: 'sourceSha must be 40 lowercase hex characters' });
  } else if (evidence.sourceSha !== expected?.sourceSha) {
    errors.push({ path: 'sourceSha', message: 'sourceSha must match the accepted source SHA' });
  }

  if (typeof evidence.newVersion !== 'string' || evidence.newVersion.length === 0) {
    errors.push({ path: 'newVersion', message: 'newVersion is required' });
  } else if (evidence.newVersion !== expected?.newVersion) {
    errors.push({ path: 'newVersion', message: 'newVersion must match the candidate version' });
  }

  if (typeof evidence.oldVersion !== 'string' || evidence.oldVersion.length === 0) {
    errors.push({ path: 'oldVersion', message: 'oldVersion is required' });
  } else if (typeof evidence.newVersion === 'string'
    && compareVersions(evidence.oldVersion, evidence.newVersion) >= 0) {
    errors.push({ path: 'oldVersion', message: 'oldVersion must be strictly older than newVersion' });
  }

  if (!Array.isArray(evidence.events)) {
    errors.push({ path: 'events', message: 'events must be an array' });
  } else {
    for (const event of REQUIRED_EVENTS) {
      if (!evidence.events.includes(event)) {
        errors.push({ path: `events.${event}`, message: `required lifecycle event ${event} is missing` });
      }
    }
  }

  if (!isPlainObject(evidence.cleanup)) {
    errors.push({ path: 'cleanup', message: 'cleanup facts are required' });
  } else {
    for (const fact of [ 'oldAppStopped', 'relaunchedAppStopped', 'fixtureStopped', 'removedUserData' ]) {
      if (evidence.cleanup[fact] !== true) {
        errors.push({ path: `cleanup.${fact}`, message: `owned cleanup fact ${fact} must be true` });
      }
    }
  }

  if (!isPlainObject(evidence.newZip)
    || !SHA256_PATTERN.test(String(evidence.newZip.sha256 ?? ''))
    || !SHA512_BASE64_PATTERN.test(String(evidence.newZip.sha512 ?? ''))
    || !Number.isSafeInteger(evidence.newZip.size)
    || evidence.newZip.size <= 0) {
    errors.push({ path: 'newZip', message: 'newZip must record sha256, base64 sha512 and size' });
  }
  if (expected?.newZipSha256 !== undefined && evidence.newZip?.sha256 !== expected.newZipSha256) {
    errors.push({ path: 'newZip.sha256', message: 'newZip.sha256 must match the uploaded candidate archive' });
  }
  if (expected?.newZipSize !== undefined && evidence.newZip?.size !== expected.newZipSize) {
    errors.push({ path: 'newZip.size', message: 'newZip.size must match the uploaded candidate archive' });
  }
  if (expected?.requireNameVersion === true
    && typeof evidence.newZip?.name === 'string'
    && typeof evidence.newVersion === 'string') {
    // Electron builder artifact names carry the release core; a prerelease
    // suffix may be normalized, so bind to the X.Y.Z core, not the rc string.
    const releaseCore = evidence.newVersion.replace(/^v/, '').split(/[-+]/)[0];
    if (!evidence.newZip.name.includes(releaseCore)) {
      errors.push({ path: 'newZip.name', message: 'newZip.name must include the candidate release version' });
    }
  }

  if (!SHA256_PATTERN.test(String(evidence.oldBinarySha256 ?? ''))) {
    errors.push({ path: 'oldBinarySha256', message: 'oldBinarySha256 must record the pre-launch old binary' });
  }

  if (evidence.oldZip !== undefined) {
    if (!isPlainObject(evidence.oldZip) || !SHA256_PATTERN.test(String(evidence.oldZip.sha256 ?? ''))) {
      errors.push({ path: 'oldZip', message: 'oldZip, when present, must record a sha256' });
    } else if (typeof evidence.oldVersion === 'string' && evidence.oldZip.version !== evidence.oldVersion) {
      errors.push({ path: 'oldZip.version', message: 'oldZip.version must match oldVersion' });
    }
  }

  if (evidence.oldReleaseTag !== undefined) {
    if (typeof evidence.oldReleaseTag !== 'string' || !evidence.oldReleaseTag.startsWith('v')) {
      errors.push({ path: 'oldReleaseTag', message: 'oldReleaseTag must be a v-prefixed release tag' });
    } else if (typeof evidence.oldVersion === 'string'
      && evidence.oldReleaseTag !== `v${evidence.oldVersion}`) {
      errors.push({ path: 'oldReleaseTag', message: 'oldReleaseTag must match oldVersion' });
    }
  }

  return { valid: errors.length === 0, errors };
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error(`failed to read JSON file: ${filePath}`);
  }
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${optionName} requires a value`);
  return value;
}

function parseVerifyArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--evidence': args.evidence = readOptionValue(argv, i, arg); i += 1; break;
      case '--source-sha': args.sourceSha = readOptionValue(argv, i, arg); i += 1; break;
      case '--new-version': args.newVersion = readOptionValue(argv, i, arg); i += 1; break;
      case '--expected-new-zip': args.expectedNewZip = readOptionValue(argv, i, arg); i += 1; break;
      case '--checks-out': args.checksOut = readOptionValue(argv, i, arg); i += 1; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!args.evidence) throw new Error('--evidence is required');
  if (!SOURCE_SHA_PATTERN.test(String(args.sourceSha ?? ''))) throw new Error('--source-sha must be 40 lowercase hex characters');
  if (!args.newVersion) throw new Error('--new-version is required');
  return args;
}

function main(argv = process.argv.slice(2)) {
  const [ command, ...rest ] = argv;
  if (command !== 'verify') throw new Error('command must be verify');

  const args = parseVerifyArgs(rest);
  const expected = { sourceSha: args.sourceSha, newVersion: args.newVersion };
  if (args.expectedNewZip) {
    if (!fs.statSync(args.expectedNewZip, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`--expected-new-zip does not exist: ${args.expectedNewZip}`);
    }
    expected.newZipSha256 = sha256File(args.expectedNewZip);
    expected.newZipSize = fs.statSync(args.expectedNewZip).size;
    expected.requireNameVersion = true;
  }

  const evidence = readJsonFile(args.evidence);
  const result = verifyEvidence(evidence, expected);

  if (args.checksOut && result.valid) {
    fs.writeFileSync(args.checksOut, `${JSON.stringify({ desktop: 'passed' }, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.valid ? 0 : 1;
}

module.exports = { compareVersions, verifyEvidence };

if (require.main === module) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`[desktop-self-update-acceptance] ${error.message}`);
    process.exit(1);
  }
}
