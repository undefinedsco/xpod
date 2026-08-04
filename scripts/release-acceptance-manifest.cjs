#!/usr/bin/env node
const fs = require('node:fs');

const ALLOWED_TOP_LEVEL_FIELDS = [
  'schemaVersion',
  'targetVersion',
  'candidateVersion',
  'sourceSha',
  'sourceBranch',
  'imageDigest',
  'npmPackage',
  'npmVersion',
  'endpoint',
  'acceptedAt',
  'checks',
];

const SENSITIVE_FIELD_PATTERN = /(?:secret|token|password|credential|api[-_]?key)/i;
const STABLE_TAG_PATTERN = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_TRAVERSAL_DEPTH = 32;
const MAX_TRAVERSAL_NODES = 2000;

function createManifest(input) {
  return {
    schemaVersion: 1,
    targetVersion: input.targetVersion,
    candidateVersion: input.candidateVersion,
    sourceSha: input.sourceSha,
    sourceBranch: input.sourceBranch,
    imageDigest: input.imageDigest,
    npmPackage: input.npmPackage,
    npmVersion: input.npmVersion,
    endpoint: input.endpoint,
    acceptedAt: input.acceptedAt,
    checks: { ...input.checks },
  };
}

function addError(errors, path, message) {
  errors.push({ path, message });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function scanSensitiveFields(value, errors, path = '') {
  if ((!isPlainObject(value) && !Array.isArray(value)) || path === 'checks') {
    return;
  }

  const seen = new WeakSet();
  const stack = [{ value, path, depth: 0 }];
  let visitedNodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || (!isPlainObject(current.value) && !Array.isArray(current.value))) {
      continue;
    }

    if (seen.has(current.value)) {
      addError(errors, current.path, 'cyclic object reference is not allowed');
      continue;
    }
    seen.add(current.value);

    visitedNodes += 1;
    if (visitedNodes > MAX_TRAVERSAL_NODES) {
      addError(errors, current.path, 'maximum traversal nodes exceeded');
      continue;
    }

    if (current.depth > MAX_TRAVERSAL_DEPTH) {
      addError(errors, current.path, 'maximum traversal depth exceeded');
      continue;
    }

    const entries = Array.isArray(current.value)
      ? current.value.map((item, index) => [ String(index), item ])
      : Object.entries(current.value);

    for (const [ key, childValue ] of entries) {
      const childPath = current.path ? `${current.path}.${key}` : key;
      if (SENSITIVE_FIELD_PATTERN.test(key)) {
        addError(errors, childPath, 'sensitive fields are not allowed');
      }
      if (childPath !== 'checks') {
        stack.push({ value: childValue, path: childPath, depth: current.depth + 1 });
      }
    }
  }
}

function validateRequiredString(manifest, errors, field) {
  if (!Object.hasOwn(manifest, field) || typeof manifest[field] !== 'string' || manifest[field].length === 0) {
    addError(errors, field, `${field} is required`);
    return false;
  }

  return true;
}

function validateIsoTimestamp(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) {
    return false;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validateManifest(manifest, expected) {
  const errors = [];

  if (!isPlainObject(manifest)) {
    return {
      valid: false,
      errors: [{ path: '', message: 'manifest must be a JSON object' }],
    };
  }

  scanSensitiveFields(manifest, errors);

  for (const field of Object.keys(manifest)) {
    if (!ALLOWED_TOP_LEVEL_FIELDS.includes(field)) {
      addError(errors, field, 'top-level field is not declared in schema');
    }
  }

  for (const field of ALLOWED_TOP_LEVEL_FIELDS) {
    if (!Object.hasOwn(manifest, field)) {
      addError(errors, field, `${field} is required`);
    }
  }

  if (manifest.schemaVersion !== 1) {
    addError(errors, 'schemaVersion', 'schemaVersion must be 1');
  }

  const tagMatch = STABLE_TAG_PATTERN.exec(String(expected?.tag ?? ''));
  if (!tagMatch) {
    addError(errors, 'targetVersion', 'expected tag must be a stable v<version> tag');
  }

  if (!Array.isArray(expected?.requiredChecks) || expected.requiredChecks.length === 0) {
    addError(errors, 'requiredChecks', 'expected requiredChecks must contain at least one check');
  }

  const targetVersion = tagMatch?.[1];
  validateRequiredString(manifest, errors, 'targetVersion');
  validateRequiredString(manifest, errors, 'candidateVersion');
  validateRequiredString(manifest, errors, 'sourceSha');
  validateRequiredString(manifest, errors, 'sourceBranch');
  validateRequiredString(manifest, errors, 'imageDigest');
  validateRequiredString(manifest, errors, 'npmPackage');
  validateRequiredString(manifest, errors, 'npmVersion');
  validateRequiredString(manifest, errors, 'endpoint');

  if (targetVersion && manifest.targetVersion !== targetVersion) {
    addError(errors, 'targetVersion', 'targetVersion must match the stable tag');
  }

  if (manifest.sourceSha !== expected?.sourceSha) {
    addError(errors, 'sourceSha', 'sourceSha must match the expected source SHA');
  }

  if (!SOURCE_SHA_PATTERN.test(manifest.sourceSha)) {
    addError(errors, 'sourceSha', 'sourceSha must be exactly 40 lowercase hex characters');
  }

  if (targetVersion && manifest.sourceBranch !== `release/${targetVersion}`) {
    addError(errors, 'sourceBranch', 'sourceBranch must match release/<version>');
  }

  if (targetVersion && !new RegExp(`^${escapeRegExp(targetVersion)}-rc\\.[1-9]\\d*(?:\\.[1-9]\\d*)?$`).test(manifest.candidateVersion)) {
    addError(errors, 'candidateVersion', 'candidateVersion must be an rc for the target version');
  }

  if (manifest.npmPackage !== '@undefineds.co/xpod') {
    addError(errors, 'npmPackage', 'npmPackage must be @undefineds.co/xpod');
  }

  if (manifest.npmVersion !== manifest.candidateVersion) {
    addError(errors, 'npmVersion', 'npmVersion must equal candidateVersion');
  }

  if (manifest.endpoint !== 'https://id-rc.undefineds.co') {
    addError(errors, 'endpoint', 'endpoint must match the release candidate endpoint');
  }

  if (!IMAGE_DIGEST_PATTERN.test(manifest.imageDigest)) {
    addError(errors, 'imageDigest', 'imageDigest must be an immutable sha256 digest');
  }

  if (!validateIsoTimestamp(manifest.acceptedAt)) {
    addError(errors, 'acceptedAt', 'acceptedAt must be a valid ISO timestamp');
  }

  if (!isPlainObject(manifest.checks)) {
    addError(errors, 'checks', 'checks must be a plain object');
    if (manifest.checks && typeof manifest.checks === 'object') {
      for (const checkName of expected?.requiredChecks ?? []) {
        if (!Object.hasOwn(manifest.checks, checkName) || manifest.checks[checkName] !== 'passed') {
          addError(errors, `checks.${checkName}`, 'required check must be present and passed');
        }
      }
    }
  } else {
    for (const [ checkName, checkValue ] of Object.entries(manifest.checks)) {
      if (checkValue !== 'passed') {
        addError(errors, `checks.${checkName}`, 'check value must be passed');
      }
    }

    for (const checkName of expected?.requiredChecks ?? []) {
      if (!Object.hasOwn(manifest.checks, checkName) || manifest.checks[checkName] !== 'passed') {
        addError(errors, `checks.${checkName}`, 'required check must be present and passed');
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value`);
  }

  return value;
}

function parseCreateArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--target-version':
        args.targetVersion = readOptionValue(argv, i, arg);
        i += 1;
        break;
      case '--candidate-version':
        args.candidateVersion = readOptionValue(argv, i, arg);
        i += 1;
        break;
      case '--source-sha':
        args.sourceSha = readOptionValue(argv, i, arg);
        i += 1;
        break;
      case '--source-branch':
        args.sourceBranch = readOptionValue(argv, i, arg);
        i += 1;
        break;
      case '--image-digest':
        args.imageDigest = readOptionValue(argv, i, arg);
        i += 1;
        break;
      case '--npm-package':
        args.npmPackage = readOptionValue(argv, i, arg);
        i += 1;
        break;
      case '--npm-version':
        args.npmVersion = readOptionValue(argv, i, arg);
        i += 1;
        break;
      case '--endpoint':
        args.endpoint = readOptionValue(argv, i, arg);
        i += 1;
        break;
      case '--accepted-at':
        args.acceptedAt = readOptionValue(argv, i, arg);
        i += 1;
        break;
      case '--checks-file':
        args.checks = readJsonFile(readOptionValue(argv, i, arg));
        i += 1;
        break;
      default:
        throw new Error('unknown argument');
    }
  }

  return args;
}

function parseValidateArgs(argv) {
  const args = {
    requiredChecks: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--manifest':
        args.manifest = readJsonFile(readOptionValue(argv, i, arg));
        i += 1;
        break;
      case '--tag':
        args.tag = readOptionValue(argv, i, arg);
        i += 1;
        break;
      case '--source-sha':
        args.sourceSha = readOptionValue(argv, i, arg);
        i += 1;
        break;
      case '--required-check':
        args.requiredChecks.push(readOptionValue(argv, i, arg));
        i += 1;
        break;
      default:
        throw new Error('unknown argument');
    }
  }

  if (!args.manifest) {
    throw new Error('--manifest requires a value');
  }

  return args;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error('failed to read JSON file');
  }
}

function main(argv = process.argv.slice(2)) {
  const [ command, ...rest ] = argv;

  if (command === 'create') {
    const input = parseCreateArgs(rest);
    const manifest = createManifest(input);
    const result = validateManifest(manifest, {
      tag: `v${manifest.targetVersion}`,
      sourceSha: manifest.sourceSha,
      requiredChecks: Object.keys(manifest.checks),
    });
    if (!isPlainObject(input.checks) || Object.keys(input.checks).length === 0) {
      addError(result.errors, 'checks', 'checks-file must contain at least one check');
      result.valid = false;
    }
    if (!result.valid) {
      throw new Error('manifest validation failed');
    }
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return 0;
  }

  if (command === 'validate') {
    const args = parseValidateArgs(rest);
    const result = validateManifest(args.manifest, {
      tag: args.tag,
      sourceSha: args.sourceSha,
      requiredChecks: args.requiredChecks,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.valid ? 0 : 1;
  }

  throw new Error('command must be create or validate');
}

if (require.main === module) {
  try {
    const exitCode = main();
    process.exit(exitCode);
  } catch (error) {
    console.error(`[release-acceptance-manifest] ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  createManifest,
  main,
  validateManifest,
};
