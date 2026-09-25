#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const packJsonPath = process.argv[2] || 'pack.json';
const packedSizeLimitMb = Number(process.env.XPOD_MAX_PACKED_SIZE_MB || '20');
// The controlled runtime bundle includes authentication patches that consumers
// cannot reconstruct from the registry. See docs/testing/login-release-0.4.7.md.
const unpackedSizeLimitMb = Number(process.env.XPOD_MAX_UNPACKED_SIZE_MB || '48');

const resolvedPath = path.resolve(packJsonPath);
const items = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
const pack = Array.isArray(items) ? items[0] : items;

if (!pack) {
  throw new Error(`No pack metadata found in ${resolvedPath}`);
}

const badFile = (pack.files || []).find((file) => /(?:^|\/)xpod-single(?:\.single)?\.cjs$/.test(file.path));
if (badFile) {
  throw new Error(`Standalone artifact leaked into npm tarball: ${badFile.path}`);
}

const platformBinaryFile = (pack.files || []).find((file) => /(?:^|\/)dist\/npm(?:\/|$)/.test(file.path));
if (platformBinaryFile) {
  throw new Error(`Platform binary artifact leaked into npm tarball: ${platformBinaryFile.path}`);
}

// Compiler diagnostics are not runtime payload, including bundled dependencies.
// Keep unrelated .map resource files, which may be consumed by the application.
const sourceMapFile = (pack.files || []).find((file) => /\.[cm]?[jt]sx?\.map$/.test(file.path));
if (sourceMapFile) {
  throw new Error(`Source map leaked into npm tarball: ${sourceMapFile.path}`);
}
const buildCacheFile = (pack.files || []).find((file) => /\.tsbuildinfo$/.test(file.path));
if (buildCacheFile) {
  throw new Error(`Build cache leaked into npm tarball: ${buildCacheFile.path}`);
}

// Bundled dependencies are copied file by file, so their test sources would
// otherwise ride along even though no runtime path can load them.
const bundledTestFile = (pack.files || []).find((file) =>
  /(?:^|\/)node_modules\//.test(file.path) &&
  (/(?:^|\/)__tests__\//.test(file.path) || /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file.path)));
if (bundledTestFile) {
  throw new Error(`Bundled dependency test source leaked into npm tarball: ${bundledTestFile.path}`);
}

const packedLimitBytes = packedSizeLimitMb * 1024 * 1024;
const unpackedLimitBytes = unpackedSizeLimitMb * 1024 * 1024;

if (typeof pack.size === 'number' && pack.size > packedLimitBytes) {
  throw new Error(`Packed tarball too large: ${pack.size} bytes > ${packedLimitBytes} bytes`);
}

if (typeof pack.unpackedSize === 'number' && pack.unpackedSize > unpackedLimitBytes) {
  throw new Error(`Unpacked tarball too large: ${pack.unpackedSize} bytes > ${unpackedLimitBytes} bytes`);
}

console.log(`[pack-check] ok: ${pack.filename}`);
console.log(`[pack-check] packed=${pack.size} unpacked=${pack.unpackedSize}`);
