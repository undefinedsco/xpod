#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const packJsonPath = process.argv[2] || 'pack.json';
const packedSizeLimitMb = Number(process.env.XPOD_MAX_PACKED_SIZE_MB || '20');
const unpackedSizeLimitMb = Number(process.env.XPOD_MAX_UNPACKED_SIZE_MB || '40');

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
