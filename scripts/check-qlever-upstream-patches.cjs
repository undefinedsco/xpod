#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const patchesRoot = path.join(repoRoot, 'native/postgres/qlever_adapter/patches');
const patchSpecs = [
  {
    patchPath: path.join(patchesRoot, 'qlever-indexscan-physical-lazy-scan.patch'),
    target: 'src/engine/IndexScan.cpp',
    patchTokens: [
      'XpodQleverPhysicalIndexScanContextBridge.hpp',
      'lazyScanRangeFromQleverScanSpecAndBlocks',
      '!scanSpecAndBlocksIsPrefiltered_',
      'permutation().lazyScan(',
    ],
    anchors: [
      'IndexScan::getLazyScan(',
      'auto filteredBlocks =',
      'permutation().lazyScan(',
      'scanSpecAndBlocks_',
    ],
    appliedTokens: [
      'XpodQleverPhysicalIndexScanContextBridge.hpp',
      'xpod::qlever::lazyScanRangeFromQleverScanSpecAndBlocks',
      '!scanSpecAndBlocksIsPrefiltered_',
      'xpodLazyScan.status == XPOD_RDF_STATUS_OK',
      'permutation().lazyScan(',
    ],
    alreadyPatchedMessage: 'already contains the Xpod IndexScan lazy-scan overlay',
  },
  {
    patchPath: path.join(patchesRoot, 'qlever-libcxx-normalized-string.patch'),
    target: 'src/parser/NormalizedString.h',
    patchTokens: [
      'constexpr operator char() const noexcept',
      'using NormalizedString = std::string;',
      'using NormalizedStringView = std::string_view;',
    ],
    anchors: [
      'using NormalizedString = std::basic_string<NormalizedChar>;',
      'using NormalizedStringView = std::basic_string_view<NormalizedChar>;',
      'reinterpret_cast<const NormalizedChar*>',
    ],
    appliedTokens: [
      'constexpr operator char() const noexcept',
      'using NormalizedString = std::string;',
      'using NormalizedStringView = std::string_view;',
      'return normalizedStringView;',
      'return input;',
    ],
    alreadyPatchedMessage: 'already contains the libc++ normalized-string overlay',
  },
  {
    patchPath: path.join(patchesRoot, 'qlever-libcxx-string-sort-comparator.patch'),
    target: 'src/index/StringSortComparator.h',
    patchTokens: [
      'using U8String = std::string;',
      'using U8StringView = std::string_view;',
      'using SortKey = SortKeyImpl<std::string>;',
      'using SortKeyView = SortKeyImpl<std::string_view>;',
    ],
    anchors: [
      'using U8String = std::basic_string<uint8_t>;',
      'using U8StringView = std::basic_string_view<uint8_t>;',
      'using SortKey = SortKeyImpl<std::basic_string<uint8_t>>;',
      'using SortKeyView = SortKeyImpl<std::basic_string_view<uint8_t>>;',
    ],
    appliedTokens: [
      'using U8String = std::string;',
      'using U8StringView = std::string_view;',
      'using SortKey = SortKeyImpl<std::string>;',
      'using SortKeyView = SortKeyImpl<std::string_view>;',
    ],
    alreadyPatchedMessage: 'already contains the libc++ byte-string sort-key overlay',
  },
  {
    patchPath: path.join(patchesRoot, 'qlever-libcxx-string-utils.patch'),
    target: 'src/util/StringUtils.h',
    patchTokens: [
      'const volatile unsigned char* bytes1',
      'const volatile unsigned char* bytes2',
      'volatile unsigned char mismatchFound',
    ],
    anchors: [
      'std::basic_string_view<volatile std::byte>',
      'volatile std::byte mismatchFound',
      'return impl(toVolatile(view1), toVolatile(view2));',
    ],
    appliedTokens: [
      'const volatile unsigned char* bytes1',
      'const volatile unsigned char* bytes2',
      'volatile unsigned char mismatchFound',
    ],
    alreadyPatchedMessage: 'already contains the libc++ constant-time compare overlay',
  },
  {
    patchPath: path.join(patchesRoot, 'qlever-queryexecutioncontext-physical-index.patch'),
    target: 'src/engine/QueryExecutionContext.h',
    patchTokens: [
      'class XpodQleverPhysicalIndex',
      'setXpodPhysicalIndex',
      'xpodPhysicalIndex() const',
    ],
    anchors: [
      'class QueryExecutionContext',
      '[[nodiscard]] const Index& getIndex() const',
      'std::shared_ptr<const Index> _index',
    ],
    appliedTokens: [
      'class XpodQleverPhysicalIndex',
      'setXpodPhysicalIndex',
      'xpodPhysicalIndex() const',
      'std::shared_ptr<const xpod::qlever::XpodQleverPhysicalIndex>',
    ],
    alreadyPatchedMessage: 'already contains the Xpod physical-index context overlay',
  },
];

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

function gitApplyEnvironment(sourceDir) {
  const ceiling = path.dirname(sourceDir);
  const existingCeilings = process.env.GIT_CEILING_DIRECTORIES;
  return {
    ...process.env,
    GIT_CEILING_DIRECTORIES: existingCeilings
      ? `${ceiling}${path.delimiter}${existingCeilings}`
      : ceiling,
  };
}

const qleverSourceInput = readArg('--qlever-source') || process.env.XPOD_QLEVER_SOURCE_DIR;
const qleverSource = qleverSourceInput ? path.resolve(qleverSourceInput) : '';
const patchInput = readArg('--patch');
const shouldApply = process.argv.includes('--apply');

if (!qleverSource) {
  fail('missing --qlever-source or XPOD_QLEVER_SOURCE_DIR');
}
const specs = patchInput
  ? patchSpecs.filter((spec) => path.resolve(spec.patchPath) === path.resolve(patchInput))
  : patchSpecs;
if (specs.length === 0) {
  fail(`unknown QLever upstream patch asset: ${patchInput}`);
}

let checked = 0;
const gitEnv = gitApplyEnvironment(qleverSource);
for (const spec of specs) {
  const patchPath = path.resolve(spec.patchPath);
  if (!fs.existsSync(patchPath)) {
    fail(`missing patch asset: ${path.relative(repoRoot, patchPath)}`);
  }
  const targetPath = path.join(qleverSource, spec.target);
  if (!fs.existsSync(targetPath)) {
    fail(`missing upstream source file: ${targetPath}`);
  }

  const patch = fs.readFileSync(patchPath, 'utf8');
  for (const required of spec.patchTokens) {
    if (!patch.includes(required)) {
      fail(`patch asset is missing required token: ${required}`);
    }
  }

  const source = fs.readFileSync(targetPath, 'utf8');
  const alreadyPatched = spec.appliedTokens.every((token) => source.includes(token));
  if (alreadyPatched) {
    console.log(`[qlever-upstream-patches] OK: ${targetPath} ${spec.alreadyPatchedMessage}.`);
    checked += 1;
    continue;
  }
  for (const required of spec.anchors) {
    if (!source.includes(required)) {
      fail(`upstream ${spec.target} does not expose expected patch anchor: ${required}`);
    }
  }

  try {
    execFileSync('git', [
      'apply',
      '--check',
      patchPath,
    ], { cwd: qleverSource, stdio: 'pipe', env: gitEnv });
    if (shouldApply) {
      execFileSync('git', [
        'apply',
        patchPath,
      ], { cwd: qleverSource, stdio: 'pipe', env: gitEnv });
      const appliedSource = fs.readFileSync(targetPath, 'utf8');
      if (!spec.appliedTokens.every((token) => appliedSource.includes(token))) {
        fail(`QLever upstream patch command completed but ${spec.target} does not contain the expected overlay`);
      }
    }
  } catch (error) {
    fail(`QLever upstream patch does not apply cleanly: ${path.relative(repoRoot, patchPath)}`, error);
  }

  console.log(
    `[qlever-upstream-patches] OK: ${path.relative(repoRoot, patchPath)} applies to ${targetPath}`,
  );
  checked += 1;
}

console.log(`[qlever-upstream-patches] OK: checked ${checked} patch(es).`);
