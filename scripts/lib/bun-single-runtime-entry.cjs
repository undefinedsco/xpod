'use strict';
const zlib = require('node:zlib');

// Compress file bytes directly; base64 inside JSON wastes the platform budget.
function encodeSingleBinaryArchive(files) {
  const metadata = [];
  const contents = [];
  let offset = 0;
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const content = Buffer.from(file.content);
    metadata.push({ path: file.path, offset, length: content.length, mode: file.mode });
    contents.push(content);
    offset += content.length;
  }
  const header = Buffer.from(JSON.stringify(metadata));
  const prefix = Buffer.alloc(12);
  prefix.write('XPODAR01');
  prefix.writeUInt32LE(header.length, 8);
  return zlib.brotliCompressSync(Buffer.concat([prefix, header, ...contents]), {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 },
  });
}

// Keep bootstrap generation testable without executing the package build.
function createSingleBinaryEntry(manifestSha, compressedManifest) {
  return [
    'import crypto from \'node:crypto\';',
    'import fs from \'node:fs\';',
    'import os from \'node:os\';',
    'import path from \'node:path\';',
    'import zlib from \'node:zlib\';',
    'import { pathToFileURL } from \'node:url\';',
    '',
    `const ARCHIVE_SHA256 = '${manifestSha}';`,
    `const MANIFEST_BASE64 = '${compressedManifest.toString('base64')}';`,
    '',
    'function resolveCacheRoot(): string {',
    '  const candidates = [',
    '    process.env.XPOD_BUN_SINGLE_CACHE_DIR,',
    '    path.join(os.tmpdir(), \'xpod-bun-cache\'),',
    '    path.join(os.homedir(), \'.xpod\', \'bun-single-cache\'),',
    '  ].filter((value): value is string => typeof value === \'string\' && value.length > 0);',
    '  for (const candidate of candidates) {',
    '    try {',
    '      const absolute = path.resolve(candidate);',
    '      fs.mkdirSync(absolute, { recursive: true });',
    '      return absolute;',
    '    } catch {',
    '    }',
    '  }',
    '  throw new Error(\'No writable cache directory found for Bun single binary.\');',
    '}',
    '',
    'function ensureExtracted(cacheDir: string): void {',
    '  const marker = path.join(cacheDir, \'.xpod-bun-single-ready\');',
    '  const entryPath = path.join(cacheDir, \'dist\', \'__cli__.cjs\');',
    '  try {',
    '    if (fs.readFileSync(marker, \'utf8\').trim() === ARCHIVE_SHA256 && fs.statSync(entryPath).isFile()) {',
    '      return;',
    '    }',
    '  } catch {',
    '  }',
    '  if (fs.existsSync(cacheDir)) {',
    '    fs.rmSync(cacheDir, { recursive: true, force: true });',
    '  }',
    '  fs.mkdirSync(cacheDir, { recursive: true });',
    '  const compressedManifest = Buffer.from(MANIFEST_BASE64, \'base64\');',
    '  const actualSha = crypto.createHash(\'sha256\').update(compressedManifest).digest(\'hex\');',
    '  if (actualSha !== ARCHIVE_SHA256) {',
    '    throw new Error(\'Embedded manifest checksum mismatch.\');',
    '  }',
    '  const archive = zlib.brotliDecompressSync(compressedManifest);',
    '  if (archive.length < 12 || archive.subarray(0, 8).toString() !== \'XPODAR01\') throw new Error(\'Invalid embedded archive format\');',
    '  const bodyOffset = 12 + archive.readUInt32LE(8);',
    '  if (bodyOffset > archive.length) throw new Error(\'Invalid embedded archive header\');',
    '  const manifest = JSON.parse(archive.subarray(12, bodyOffset).toString(\'utf8\')) as Array<{ path: string; offset: number; length: number; mode: number }>;',
    '  for (const item of manifest) {',
    '    if (!Number.isSafeInteger(item.offset) || !Number.isSafeInteger(item.length) || item.offset < 0 || item.length < 0',
    '      || item.offset + item.length > archive.length - bodyOffset) throw new Error(\'Invalid embedded archive file range\');',
    '    const targetPath = path.join(cacheDir, item.path);',
    '    fs.mkdirSync(path.dirname(targetPath), { recursive: true });',
    '    fs.writeFileSync(targetPath, archive.subarray(bodyOffset + item.offset, bodyOffset + item.offset + item.length));',
    '    if (process.platform !== \'win32\' && typeof item.mode === \'number\') {',
    '      fs.chmodSync(targetPath, item.mode);',
    '    }',
    '  }',
    '  fs.writeFileSync(marker, `${ARCHIVE_SHA256}\\n`);',
    '}',
    '',
    'async function main(): Promise<void> {',
    '  const cacheRoot = resolveCacheRoot();',
    '  const cacheDir = path.join(cacheRoot, ARCHIVE_SHA256.slice(0, 16));',
    '  ensureExtracted(cacheDir);',
    '  const entryPath = path.join(cacheDir, \'dist\', \'__cli__.cjs\');',
    '  const argv0 = process.argv[0] ?? process.execPath;',
    '  const childEntrypointAtArgv1 = process.argv[1]?.startsWith(\'__internal-\') === true;',
    '  const userArgs = childEntrypointAtArgv1 ? process.argv.slice(1) : process.argv.slice(2);',
    '  process.argv = [argv0, entryPath, ...userArgs];',
    '  process.env.XPOD_BUN_SINGLE_RUNTIME = \'1\';',
    '  process.chdir(cacheDir);',
    '  await import(pathToFileURL(entryPath).href);',
    '}',
    '',
    'void main();',
    '',
  ].join('\n');
}

module.exports = { createSingleBinaryEntry, encodeSingleBinaryArchive };
