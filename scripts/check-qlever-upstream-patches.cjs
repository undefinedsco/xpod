#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const defaultPatchPath = path.join(
  repoRoot,
  'native/postgres/qlever_adapter/patches/qlever-indexscan-physical-lazy-scan.patch',
);

function fail(message, error) {
  console.error(`[qlever-upstream-patches] ${message}`);
  if (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

const qleverSourceInput = readArg('--qlever-source') || process.env.XPOD_QLEVER_SOURCE_DIR;
const qleverSource = qleverSourceInput ? path.resolve(qleverSourceInput) : '';
const patchPath = path.resolve(readArg('--patch') || defaultPatchPath);
const shouldApply = process.argv.includes('--apply');

if (!qleverSource) {
  fail('missing --qlever-source or XPOD_QLEVER_SOURCE_DIR');
}
if (!fs.existsSync(patchPath)) {
  fail(`missing patch asset: ${path.relative(repoRoot, patchPath)}`);
}

const indexScanPath = path.join(qleverSource, 'src/engine/IndexScan.cpp');
if (!fs.existsSync(indexScanPath)) {
  fail(`missing upstream source file: ${indexScanPath}`);
}

const patch = fs.readFileSync(patchPath, 'utf8');
for (const required of [
  'XpodQleverPhysicalIndexScanContextBridge.hpp',
  'lazyScanRangeFromQleverScanSpecAndBlocks',
  'permutation().lazyScan(',
]) {
  if (!patch.includes(required)) {
    fail(`patch asset is missing required token: ${required}`);
  }
}

const source = fs.readFileSync(indexScanPath, 'utf8');
const alreadyPatched =
  source.includes('XpodQleverPhysicalIndexScanContextBridge.hpp') &&
  source.includes('xpod::qlever::lazyScanRangeFromQleverScanSpecAndBlocks') &&
  source.includes('xpodLazyScan.status == XPOD_RDF_STATUS_OK') &&
  source.includes('permutation().lazyScan(');
if (alreadyPatched) {
  console.log(
    `[qlever-upstream-patches] OK: ${indexScanPath} already contains the Xpod IndexScan lazy-scan overlay.`,
  );
  process.exit(0);
}
for (const required of [
  'IndexScan::getLazyScan(',
  'auto filteredBlocks =',
  'permutation().lazyScan(',
  'scanSpecAndBlocks_',
]) {
  if (!source.includes(required)) {
    fail(`upstream IndexScan.cpp does not expose expected patch anchor: ${required}`);
  }
}

try {
  execFileSync('git', [
    'apply',
    '--check',
    patchPath,
  ], { cwd: qleverSource, stdio: 'pipe' });
  if (shouldApply) {
    execFileSync('git', [
      'apply',
      patchPath,
    ], { cwd: qleverSource, stdio: 'pipe' });
  }
} catch (error) {
  fail('QLever upstream patch does not apply cleanly', error);
}

console.log(
  `[qlever-upstream-patches] OK: ${path.relative(repoRoot, patchPath)} applies to ${indexScanPath}`,
);
