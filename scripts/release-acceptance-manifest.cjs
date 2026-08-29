#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const IMAGE_REF_PATTERN = /^[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$/;
const SOURCE_REF_PATTERN = /^[a-f0-9]{40}$/;
const SCHEMA_VERSION = 2;

function usage() {
  return `Usage:
  node scripts/release-acceptance-manifest.cjs create --source-ref <sha> --xpod-image-digest <repo@sha256> [--postgres-image-digest <repo@sha256>] --output <path>
  node scripts/release-acceptance-manifest.cjs validate --manifest <path> --source-ref <sha> --xpod-image-digest <repo@sha256> [--postgres-image-digest <repo@sha256>] [--require-postgres-image]`;
}

function fail(message) {
  console.error(message);
  process.exit(64);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--require-postgres-image') {
      options.requirePostgresImage = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      fail(`Unexpected argument: ${arg}\n${usage()}`);
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) {
      fail(`Missing value for ${arg}\n${usage()}`);
    }
    options[arg.slice(2)] = value;
    index += 1;
  }
  return { command, options };
}

function requireSourceRef(value, name) {
  if (!SOURCE_REF_PATTERN.test(value || '')) {
    fail(`${name} must be a 40-character lowercase git SHA`);
  }
  return value;
}

function requireImageRef(value, name) {
  if (!IMAGE_REF_PATTERN.test(value || '')) {
    fail(`${name} must be an immutable repository@sha256:<64 hex> image ref`);
  }
  return value;
}

function optionalImageRef(value, name) {
  return value === undefined ? undefined : requireImageRef(value, name);
}

function createManifest(options) {
  const sourceRef = requireSourceRef(options['source-ref'], '--source-ref');
  const xpodImageDigest = requireImageRef(options['xpod-image-digest'], '--xpod-image-digest');
  const postgresImageDigest = optionalImageRef(options['postgres-image-digest'], '--postgres-image-digest');
  const output = options.output;
  if (!output) {
    fail('--output is required');
  }

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'undefineds.xpod.releaseAcceptance',
    sourceRef,
    xpodImageDigest,
    acceptedAt: new Date().toISOString(),
  };
  if (postgresImageDigest) {
    manifest.postgresImageDigest = postgresImageDigest;
  }
  if (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID) {
    manifest.workflowRun = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  }

  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote release acceptance manifest ${output}`);
}

function readManifest(path) {
  if (!path) {
    fail('--manifest is required');
  }
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`Failed to read acceptance manifest ${path}: ${error.message}`);
  }
}

function assertEqual(actual, expected, name) {
  if (actual !== expected) {
    fail(`${name} mismatch`);
  }
}

function validateManifest(options) {
  const manifest = readManifest(options.manifest);
  const expectedSourceRef = requireSourceRef(options['source-ref'], '--source-ref');
  const expectedXpodImageDigest = requireImageRef(options['xpod-image-digest'], '--xpod-image-digest');
  const expectedPostgresImageDigest = optionalImageRef(options['postgres-image-digest'], '--postgres-image-digest');

  if (options.requirePostgresImage && !expectedPostgresImageDigest) {
    fail('--postgres-image-digest is required when --require-postgres-image is set');
  }

  assertEqual(manifest.schemaVersion, SCHEMA_VERSION, 'schemaVersion');
  assertEqual(manifest.kind, 'undefineds.xpod.releaseAcceptance', 'kind');
  assertEqual(manifest.sourceRef, expectedSourceRef, 'sourceRef');
  assertEqual(manifest.xpodImageDigest, expectedXpodImageDigest, 'xpodImageDigest');
  requireImageRef(manifest.xpodImageDigest, 'manifest.xpodImageDigest');

  if (options.requirePostgresImage || expectedPostgresImageDigest) {
    requireImageRef(manifest.postgresImageDigest, 'manifest.postgresImageDigest');
  }
  if (expectedPostgresImageDigest) {
    assertEqual(manifest.postgresImageDigest, expectedPostgresImageDigest, 'postgresImageDigest');
  }

  console.log('Release acceptance manifest is valid');
}

const { command, options } = parseArgs(process.argv.slice(2));

if (command === 'create') {
  createManifest(options);
} else if (command === 'validate') {
  validateManifest(options);
} else {
  fail(`Unknown command: ${command || '<missing>'}\n${usage()}`);
}
