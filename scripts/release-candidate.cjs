#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { applyPlatformOptionalDependencies } = require('./platform-binaries.cjs');

const defaultRepoRoot = path.resolve(__dirname, '..');

function parsePositiveInteger(value, fieldName) {
  const text = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(text)) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  return text;
}

function validateSha(sha) {
  const text = String(sha ?? '').trim();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(text)) {
    throw new Error('SHA must be a full 40 or 64 character hexadecimal commit SHA');
  }

  return text;
}

function deriveCandidate({ branch, runNumber, runAttempt, sha }) {
  const branchName = String(branch ?? '').trim();
  const match = /^release\/(.+)$/.exec(branchName);
  if (!match) {
    throw new Error('branch must use release/<version>');
  }

  const targetVersion = match[1];
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(targetVersion)) {
    throw new Error('release branch version must be stable SemVer');
  }

  const parsedRunNumber = parsePositiveInteger(runNumber, 'runNumber');
  const parsedRunAttempt = parsePositiveInteger(runAttempt, 'runAttempt');
  const sourceSha = validateSha(sha);
  const candidateVersion = parsedRunAttempt === '1'
    ? `${targetVersion}-rc.${parsedRunNumber}`
    : `${targetVersion}-rc.${parsedRunNumber}.${parsedRunAttempt}`;

  return {
    targetVersion,
    candidateVersion,
    shaTag: `sha-${sourceSha}`,
    sourceSha,
  };
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value`);
  }

  return value;
}

function parseArgs(argv) {
  const args = {
    repoRoot: defaultRepoRoot,
    json: false,
    applyRootVersion: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--branch':
        args.branch = readOptionValue(argv, i, arg);
        i += 1;
        break;
      case '--run-number':
        args.runNumber = readOptionValue(argv, i, arg);
        i += 1;
        break;
      case '--run-attempt':
        args.runAttempt = readOptionValue(argv, i, arg);
        i += 1;
        break;
      case '--sha':
        args.sha = readOptionValue(argv, i, arg);
        i += 1;
        break;
      case '--repo-root':
        args.repoRoot = path.resolve(readOptionValue(argv, i, arg));
        i += 1;
        break;
      case '--json':
        args.json = true;
        break;
      case '--apply-root-version':
        args.applyRootVersion = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return args;
}

function readPackageJson(packageJsonPath) {
  return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
}

function writePackageJson(packageJsonPath, packageJson) {
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function syncPlatformPackageVersion(repoRoot, packageJsonPath) {
  if (path.resolve(repoRoot) === defaultRepoRoot) {
    execFileSync(process.execPath, [ path.join(defaultRepoRoot, 'scripts/sync-platform-package-version.cjs') ], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    return;
  }

  const packageJson = readPackageJson(packageJsonPath);
  applyPlatformOptionalDependencies(packageJson, packageJson.version);
  writePackageJson(packageJsonPath, packageJson);
}

function applyRootVersion(repoRoot, candidateVersion) {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  const packageJson = readPackageJson(packageJsonPath);
  if (packageJson.name !== '@undefineds.co/xpod') {
    throw new Error('--apply-root-version requires repoRoot to point at the root @undefineds.co/xpod package.json');
  }

  packageJson.version = candidateVersion;
  writePackageJson(packageJsonPath, packageJson);
  syncPlatformPackageVersion(repoRoot, packageJsonPath);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const metadata = deriveCandidate(args);

  if (args.applyRootVersion) {
    applyRootVersion(args.repoRoot, metadata.candidateVersion);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(metadata)}\n`);
  } else {
    process.stdout.write(`${metadata.candidateVersion}\n`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[release-candidate] ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  applyRootVersion,
  deriveCandidate,
  main,
  parseArgs,
  readOptionValue,
};
