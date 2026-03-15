#!/usr/bin/env node
const PLATFORM_PACKAGE_PREFIX = '@undefineds.co/xpod-';

const PLATFORM_TARGETS = [
  {
    id: 'darwin-arm64',
    bunTarget: 'bun-darwin-arm64',
    packageName: '@undefineds.co/xpod-darwin-arm64',
    os: [ 'darwin' ],
    cpu: [ 'arm64' ],
    label: 'macOS arm64',
    binaryName: 'xpod',
  },
  {
    id: 'darwin-x64',
    bunTarget: 'bun-darwin-x64',
    packageName: '@undefineds.co/xpod-darwin-x64',
    os: [ 'darwin' ],
    cpu: [ 'x64' ],
    label: 'macOS x64',
    binaryName: 'xpod',
  },
  {
    id: 'linux-x64-gnu',
    bunTarget: 'bun-linux-x64',
    packageName: '@undefineds.co/xpod-linux-x64-gnu',
    os: [ 'linux' ],
    cpu: [ 'x64' ],
    libc: [ 'glibc' ],
    label: 'Linux x64 (glibc)',
    binaryName: 'xpod',
  },
  {
    id: 'linux-arm64-gnu',
    bunTarget: 'bun-linux-arm64',
    packageName: '@undefineds.co/xpod-linux-arm64-gnu',
    os: [ 'linux' ],
    cpu: [ 'arm64' ],
    libc: [ 'glibc' ],
    label: 'Linux arm64 (glibc)',
    binaryName: 'xpod',
  },
  {
    id: 'linux-x64-musl',
    bunTarget: 'bun-linux-x64-musl',
    packageName: '@undefineds.co/xpod-linux-x64-musl',
    os: [ 'linux' ],
    cpu: [ 'x64' ],
    libc: [ 'musl' ],
    label: 'Linux x64 (musl)',
    binaryName: 'xpod',
  },
  {
    id: 'linux-arm64-musl',
    bunTarget: 'bun-linux-arm64-musl',
    packageName: '@undefineds.co/xpod-linux-arm64-musl',
    os: [ 'linux' ],
    cpu: [ 'arm64' ],
    libc: [ 'musl' ],
    label: 'Linux arm64 (musl)',
    binaryName: 'xpod',
  },
];

function resolvePlatformTarget(target) {
  if (!target) {
    return undefined;
  }

  return PLATFORM_TARGETS.find((candidate) =>
    candidate.id === target ||
    candidate.bunTarget === target ||
    candidate.packageName === target
  );
}

function detectLinuxLibc() {
  if (process.platform !== 'linux') {
    return undefined;
  }

  const report = process.report?.getReport?.();
  if (report?.header?.glibcVersionRuntime) {
    return 'glibc';
  }

  return 'musl';
}

function getCurrentPlatformTarget() {
  if (process.platform === 'darwin') {
    return resolvePlatformTarget(`darwin-${process.arch}`);
  }

  if (process.platform === 'linux') {
    const libc = detectLinuxLibc();
    return resolvePlatformTarget(`linux-${process.arch}-${libc === 'musl' ? 'musl' : 'gnu'}`);
  }

  return undefined;
}

function applyPlatformOptionalDependencies(packageJson, version) {
  const nextOptionalDependencies = { ...(packageJson.optionalDependencies ?? {}) };

  for (const dependencyName of Object.keys(nextOptionalDependencies)) {
    if (dependencyName.startsWith(PLATFORM_PACKAGE_PREFIX)) {
      delete nextOptionalDependencies[dependencyName];
    }
  }

  for (const target of PLATFORM_TARGETS) {
    nextOptionalDependencies[target.packageName] = version;
  }

  packageJson.optionalDependencies = nextOptionalDependencies;
  return packageJson;
}

function getPlatformDependencyMismatches(packageJson, version) {
  const optionalDependencies = packageJson.optionalDependencies ?? {};
  return PLATFORM_TARGETS
    .filter((target) => optionalDependencies[target.packageName] !== version)
    .map((target) => ({
      packageName: target.packageName,
      expected: version,
      actual: optionalDependencies[target.packageName],
    }));
}

module.exports = {
  PLATFORM_PACKAGE_PREFIX,
  PLATFORM_TARGETS,
  applyPlatformOptionalDependencies,
  detectLinuxLibc,
  getCurrentPlatformTarget,
  getPlatformDependencyMismatches,
  resolvePlatformTarget,
};
