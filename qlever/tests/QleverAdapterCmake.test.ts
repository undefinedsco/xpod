import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { fakeEncodedIriManagerHeader, fakeExportIdsHeader, fakeIndexScanHeader, fakeJoinHeader, fakeParsedQueryHeader, fakePermissiveSparqlParserHeader, fakeQueryExecutionTreeHeader, fakeQueryPlannerHeader, fakeRdfParserHeader, fakeSparqlTripleHeader, fakeTokenizerCtreHeader } from './qleverFakeHeaders';

const repoRoot = path.resolve(__dirname, '../..');
const adapterRoot = path.join(repoRoot, 'qlever/qlever_adapter');
const cmakeLists = path.join(adapterRoot, 'CMakeLists.txt');
const qleverBridgeSource = path.join(adapterRoot, 'src/XpodQleverBridge.cpp');
const nativeBuildTimeoutMs = 30_000;

const cmakeParsedQueryHeader = fakeParsedQueryHeader
  .replace(
    'explicit TripleComponent(UNDEF) : kind_(Kind::Undef) {}',
    `explicit TripleComponent(UNDEF) : kind_(Kind::Undef) {}
  explicit TripleComponent(Id id) : kind_(Kind::Id), id_(id) {}`,
  )
  .replace(
    'enum class Kind { Variable, Iri, Literal, Undef };',
    'enum class Kind { Variable, Iri, Literal, Undef, Id };',
  )
  .replace(
    'std::variant<GeoPoint> variant_{GeoPoint{}};',
    'std::variant<GeoPoint> variant_{GeoPoint{}};\n  Id id_{Id::fromBits(0)};',
  )
  .replace(
    'struct Values {\n  SparqlValues _inlineValues;\n  size_t _id = static_cast<size_t>(-1);\n};',
    `struct Values {
  SparqlValues _inlineValues;
  size_t _id = static_cast<size_t>(-1);
};
struct ExternalValuesQuery {
  std::string name_;
  std::vector<Variable> variables_;
};`,
  )
  .replace(
    'using GraphPatternOperationVariant = std::variant<BasicGraphPattern, Values, Bind, GroupGraphPattern, Optional, Minus, Union, Describe>;',
    'using GraphPatternOperationVariant = std::variant<BasicGraphPattern, Values, Bind, GroupGraphPattern, Optional, Minus, Union, Describe, ExternalValuesQuery>;',
  );

function hasCmake(): boolean {
  try {
    execFileSync('/usr/bin/env', ['cmake', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function cmakeFailureOutput(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
  return [failure.stdout, failure.stderr, failure.message]
    .filter(Boolean)
    .map((value) => Buffer.isBuffer(value) ? value.toString('utf8') : String(value))
    .join('\n');
}

async function writeRequiredQleverConfigureSkeleton(
  qleverSource: string,
  indexScanSource: string,
): Promise<void> {
  const requiredHeaders = [
    'src/libqlever/Qlever.h',
    'src/parser/SparqlParser.h',
    'src/parser/ParsedQuery.h',
    'src/parser/SparqlTriple.h',
    'src/engine/IndexScan.h',
    'src/engine/Describe.h',
    'src/engine/idTable/IdTable.h',
    'src/engine/Join.h',
    'src/engine/Operation.h',
    'src/engine/QueryExecutionContext.h',
    'src/engine/QueryExecutionTree.h',
    'src/engine/QueryPlanner.h',
    'src/engine/Result.h',
    'src/engine/RuntimeInformation.h',
    'src/global/Id.h',
    'src/index/Index.h',
    'src/index/EncodedIriManager.h',
    'src/index/ExportIds.h',
    'src/index/GraphFilter.h',
    'src/index/LocalVocab.h',
    'src/index/Permutation.h',
    'src/index/ScanSpecification.h',
    'src/util/CancellationHandle.h',
  ];
  for (const header of requiredHeaders) {
    const headerPath = path.join(qleverSource, header);
    await mkdir(path.dirname(headerPath), { recursive: true });
    await writeFile(headerPath, '#pragma once\n', 'utf8');
  }
  await writeFile(path.join(qleverSource, 'src/index/ExportIds.h'), fakeExportIdsHeader, 'utf8');
  const indexScanPath = path.join(qleverSource, 'src/engine/IndexScan.cpp');
  await mkdir(path.dirname(indexScanPath), { recursive: true });
  await writeFile(indexScanPath, indexScanSource, 'utf8');
  await writeFile(
    path.join(qleverSource, 'src/engine/TextIndexScanForWord.cpp'),
    patchedTextIndexScanForWordSource,
    'utf8',
  );
  await writeFile(
    path.join(qleverSource, 'src/engine/TextIndexScanForEntity.cpp'),
    patchedTextIndexScanForEntitySource,
    'utf8',
  );
  await writeFile(
    path.join(qleverSource, 'src/engine/QueryPlanner.cpp'),
    patchedQueryPlannerSource,
    'utf8',
  );
  await writeFile(
    path.join(qleverSource, 'src/parser/TextSearchQuery.cpp'),
    patchedTextSearchQuerySource,
    'utf8',
  );
  await writeFile(
    path.join(qleverSource, 'src/engine/Filter.cpp'),
    patchedFilterSource,
    'utf8',
  );
  await writeFile(
    path.join(qleverSource, 'src/engine/GroupByImpl.cpp'),
    patchedGroupByImplSource,
    'utf8',
  );
  await writeFile(
    path.join(qleverSource, 'src/engine/OptionalJoin.cpp'),
    patchedOptionalJoinSource,
    'utf8',
  );
  await writeFile(
    path.join(qleverSource, 'src/engine/HasPredicateScan.cpp'),
    patchedHasPredicateScanSource,
    'utf8',
  );
  await writeFile(
    path.join(qleverSource, 'src/engine/TransitivePathImpl.h'),
    patchedTransitivePathImplHeader,
    'utf8',
  );
  await writeFile(
    path.join(qleverSource, 'src/engine/Values.cpp'),
    patchedValuesSource,
    'utf8',
  );
  await writeFile(
    path.join(qleverSource, 'src/engine/Describe.cpp'),
    patchedDescribeSource,
    'utf8',
  );
  await writeFile(
    path.join(qleverSource, 'src/index/GraphFilter.h'),
    patchedGraphFilterHeader,
    'utf8',
  );
  await writeFile(
    path.join(qleverSource, 'src/index/ScanSpecification.h'),
    patchedScanSpecificationHeader,
    'utf8',
  );
  await mkdir(path.join(qleverSource, 'src/engine/sparqlExpressions'), { recursive: true });
  await writeFile(
    path.join(qleverSource, 'src/engine/sparqlExpressions/SparqlExpressionValueGetters.cpp'),
    patchedExpressionValueGettersSource,
    'utf8',
  );
  await writeFile(
    path.join(qleverSource, 'src/engine/sparqlExpressions/StringExpressions.cpp'),
    patchedStringExpressionsSource,
    'utf8',
  );
  await writeFile(
    path.join(qleverSource, 'src/engine/sparqlExpressions/RegexExpression.cpp'),
    patchedRegexExpressionSource,
    'utf8',
  );
  await writePatchedLibcxxSources(qleverSource);
  await writeAdditionalOverlayMarkers(qleverSource);
}

async function writeAdditionalOverlayMarkers(qleverSource: string): Promise<void> {
  const markerSources: Record<string, string> = {
    'src/index/IndexImpl.cpp':
      'void marker() { (void)"blankNodeManager_ = std::make_unique<ad_utility::BlankNodeManager>(0)"; }\n',
    'src/engine/sparqlExpressions/AggregateExpression.h':
      '#pragma once\n// comparePhysicalValueIds\n',
    'src/engine/sparqlExpressions/LiteralExpression.h':
      '#pragma once\n// physicalComponentIdFromContext\n',
    'src/engine/sparqlExpressions/RelationalExpressionHelpers.h':
      '#pragma once\n// comparePhysicalValueIds\n',
    'src/engine/sparqlExpressions/RelationalExpressions.cpp':
      'void marker() { (void)"context->_qec.xpodPhysicalIndex() == nullptr"; }\n',
    'src/engine/OrderBy.cpp':
      'void marker() { (void)"comparePhysicalValueIds"; }\n',
    'src/engine/Sort.cpp':
      'void marker() { (void)"IdTableUtils::sort(idTable, sortColumnIndices_);"; }\n',
    'src/engine/SpatialJoinAlgorithms.cpp':
      'void marker() { (void)"physicalWktLiteralFromContext"; }\n',
    'src/engine/SpatialJoinParser.cpp':
      'void marker() { (void)"std::move(preResolvedWkt)"; }\n',
    'src/engine/SpatialJoinParser.h':
      '#pragma once\n// std::string preResolvedWkt = {}\n',
    'src/engine/Service.cpp':
      'void marker() { (void)"SERVICE federation is disabled"; }\n',
    'src/parser/sparqlParser/SparqlQleverVisitor.cpp':
      'void marker() { (void)"visitFilterConjuncts"; }\n',
  };
  for (const [relativePath, source] of Object.entries(markerSources)) {
    const target = path.join(qleverSource, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source, 'utf8');
  }
  const operationHeader = path.join(qleverSource, 'src/engine/Operation.h');
  const operationSource = existsSync(operationHeader)
    ? readFileSync(operationHeader, 'utf8')
    : '#pragma once\n';
  await writeFile(
    operationHeader,
    `${operationSource}\n// physicalCancellationRequested(_executionContext)\n`,
    'utf8',
  );
}

const patchedTextIndexScanForWordSource = `
#include "engine/TextIndexScanForWord.h"
#include "XpodQleverPhysicalTextIndexScanContextBridge.hpp"
void xpod_text_overlay_marker() {
  (void)"textWordResultFromContext";
  (void)"textWordSizeEstimateFromContext";
}
`;

const patchedTextIndexScanForEntitySource = `
#include "engine/TextIndexScanForEntity.h"
#include "XpodQleverPhysicalTextIndexScanContextBridge.hpp"
void xpod_text_entity_overlay_marker() {
  (void)"textEntityResultFromContext";
  (void)"textEntitySizeEstimateFromContext";
}
`;

const patchedQueryPlannerSource = `
#include "engine/QueryPlanner.h"
#include "XpodQleverPhysicalIndexScanContextBridge.hpp"
#include "XpodQleverPhysicalPathSearchContextBridge.hpp"
#include "XpodQleverPhysicalTextIndexScanContextBridge.hpp"
void xpod_queryplanner_overlay_marker() {
  (void)"xpod::qlever::physicalIndexFromContext(*_qec) != nullptr";
  (void)"xpod::qlever::physicalIndexFromContext(*_qec) == nullptr";
  (void)"_enablePatternTrick && !xpodPhysicalIndex";
  (void)"ad_utility::HashSet<TripleComponent> defaultGraphs";
  (void)"Filter::Whitelist(std::move(defaultGraphs))";
  (void)"physicalPathSearchConfigurationFromContext(*qec_, pathQuery)";
  (void)"xpod::qlever::physicalIndexFromContext(*context) != nullptr";
  (void)"bestPhysicalTextTermIndexFromContext";
}
`;

const patchedTextSearchQuerySource = `
#include "parser/TextSearchQuery.h"
#include "XpodQleverPhysicalTextIndexScanContextBridge.hpp"
void xpod_text_search_query_overlay_marker() {
  (void)"bestPhysicalTextTermIndexFromContext";
}
`;

const patchedFilterSource = `
#include "engine/Filter.h"
#include "XpodQleverPhysicalFilterContextBridge.hpp"
void xpod_filter_overlay_marker() {
  (void)"physicalFilterResultFromContext";
}
`;

const unpatchedFilterSource = `
#include "engine/Filter.h"
void unpatched_filter() {
  (void)"filterIdTable(subRes->sortedBy(), subRes->idTableView())";
}
`;

const patchedGroupByImplSource = `
#include "engine/GroupByImpl.h"
#include "XpodQleverPhysicalIndexScanContextBridge.hpp"
void xpod_groupby_overlay_marker() {
  (void)"xpod::qlever::physicalIndexFromContext(*getExecutionContext()) == nullptr";
}
`;

const patchedOptionalJoinSource = `
#include "engine/OptionalJoin.h"
#include "XpodQleverPhysicalIndexScanContextBridge.hpp"
void xpod_optionaljoin_overlay_marker() {
  (void)"xpod::qlever::physicalIndexFromContext(*getExecutionContext()) == nullptr";
  (void)"prefilteredOptionalJoin_";
}
`;

const patchedHasPredicateScanSource = `
#include "engine/HasPredicateScan.h"
#include "XpodQleverPhysicalHasPredicateContextBridge.hpp"
void xpod_has_predicate_overlay_marker() {
  (void)"physicalHasPredicateResultFromContext";
  (void)"physicalHasPredicateSizeEstimateFromContext";
}
`;

const patchedTransitivePathImplHeader = `
#pragma once
#include "XpodQleverPhysicalTransitivePathContextBridge.hpp"
void xpod_transitive_overlay_marker() {
  (void)"physicalTransitivePathSideIdFromContext";
}
`;

const patchedValuesSource = `
#include "engine/Values.h"
#include "XpodQleverPhysicalValuesContextBridge.hpp"
void xpod_values_overlay_marker() {
  (void)"physicalValuesIdFromContext";
}
`;

const patchedDescribeSource = `
#include "engine/Describe.h"
#include "XpodQleverPhysicalDescribeContextBridge.hpp"
void xpod_describe_overlay_marker() {
  (void)"physicalDescribeIdFromContext";
}
`;

const patchedGraphFilterHeader = `
#pragma once
template <typename T>
class GraphFilter {
 public:
  struct AllTag {};
  using FilterType = int;
  const FilterType& xpodPhysicalFilterType() const { return filter_; }
 private:
  FilterType filter_ = 0;
};
`;

const patchedScanSpecificationHeader = `
#pragma once
class LocalVocab {
 public:
  LocalVocab clone() const { return {}; }
};
class ScanSpecification {
 public:
  const LocalVocab& xpodPhysicalLocalVocab() const { return local_vocab_; }
 private:
  LocalVocab local_vocab_;
};
`;

const patchedExpressionValueGettersSource = `
#include "engine/sparqlExpressions/SparqlExpressionValueGetters.h"
#include "XpodQleverPhysicalIndex.hpp"
void xpod_expression_value_overlay_marker() {
  (void)"xpodPhysicalStringForId";
  (void)"inlineTypedLiteralIdFromEntry";
  (void)"physicalEntry->asLiteralOrIri()";
  (void)"physicalLiteralOrIriIdFromContext";
}
`;

const patchedStringExpressionsSource = `
void xpod_string_expressions_overlay_marker() {
  (void)"Xpod may canonicalize the generated IRI to a physical dictionary Id.";
}
`;

const patchedRegexExpressionSource = `
#include "engine/sparqlExpressions/RegexExpression.h"
#include "XpodQleverPhysicalIndex.hpp"
void xpod_regex_overlay_marker() {
  (void)"xpodPhysicalPrefixRegexMatch";
}
`;

const unpatchedGroupByImplSource = `
#include "engine/GroupByImpl.h"
void unpatched_groupby() {
  (void)"computeOptimizedGroupByIfPossible()";
}
`;

const unpatchedOptionalJoinSource = `
#include "engine/OptionalJoin.h"
void unpatched_optionaljoin() {
  (void)"prefilteredOptionalJoin_";
  (void)"optionalJoinWithIndexScan(_left->getResult(true)";
}
`;

const unpatchedIndexScanSource = `
#include "engine/IndexScan.h"

CompressedRelationReader::IdTableGeneratorInputRange IndexScan::getLazyScan(
    std::optional<std::vector<CompressedBlockMetadata>> blocks) const {
  auto filteredBlocks =
      getLimitOffset().isUnconstrained() ? std::move(blocks) : std::nullopt;
  auto lazyScanAllCols = permutation().lazyScan(
      scanSpecAndBlocks_, filteredBlocks, additionalColumns(),
      cancellationHandle_, locatedTriplesState(), getLimitOffset());
  return lazyScanAllCols;
}
`;

const patchedQueryExecutionContextHeader = `
#pragma once
#include <gtest/gtest_prod.h>
#include <memory>
#include "global/Id.h"
#include "util/AllocatorWithLimit.h"
#if defined(__clang__) && __clang_major__ < 17 && !defined(QLEVER_CPP_17)
#error "QLever adapter must enable QLEVER_CPP_17 backports for clang older than 17"
#endif
#if !defined(QLEVER_CPP_17) && !defined(RANGE_V3_COMBINE_WITH_STD)
#error "QLever adapter must mirror upstream range backport compile definitions"
#endif
namespace xpod { namespace qlever { class XpodQleverPhysicalIndex; } }
class QueryExecutionContext {
 public:
  void setXpodPhysicalIndex(std::shared_ptr<const xpod::qlever::XpodQleverPhysicalIndex>) {}
  const xpod::qlever::XpodQleverPhysicalIndex* xpodPhysicalIndex() const {
    return nullptr;
  }
  const ad_utility::AllocatorWithLimit<Id>& getAllocator() const {
    return allocator_;
  }
 private:
  ad_utility::AllocatorWithLimit<Id> allocator_;
};
struct QleverCxx20Probe {
  auto operator<=>(const QleverCxx20Probe&) const = default;
};
`;

const abslDependentQueryExecutionContextHeader = patchedQueryExecutionContextHeader.replace(
  '#include <gtest/gtest_prod.h>',
  '#include <gtest/gtest_prod.h>\n#include <absl/types/compare.h>',
);

const patchedNormalizedStringHeader = `
#pragma once
#include <string>
#include <string_view>
struct NormalizedChar {
  char c_;
  constexpr operator char() const noexcept { return c_; }
};
using NormalizedString = std::string;
using NormalizedStringView = std::string_view;
`;

const unpatchedNormalizedStringHeader = `
#pragma once
#include <string>
#include <string_view>
struct NormalizedChar {
  char c_;
};
using NormalizedString = std::basic_string<NormalizedChar>;
using NormalizedStringView = std::basic_string_view<NormalizedChar>;
`;

const patchedStringSortComparatorHeader = `
#pragma once
#include <string>
#include <string_view>
class LocaleManager {
 public:
  using U8String = std::string;
  using U8StringView = std::string_view;
  template <typename T>
  class SortKeyImpl {};
  using SortKey = SortKeyImpl<std::string>;
  using SortKeyView = SortKeyImpl<std::string_view>;
};
`;

const patchedStringUtilsHeader = `
#pragma once
#include <string_view>
inline bool constantTimeEquals(std::string_view view1, std::string_view view2) {
  const volatile unsigned char* bytes1 =
      reinterpret_cast<const volatile unsigned char*>(view1.data());
  const volatile unsigned char* bytes2 =
      reinterpret_cast<const volatile unsigned char*>(view2.data());
  return bytes1 == bytes2 || view1.size() == view2.size();
}
`;

async function writePatchedLibcxxSources(qleverSource: string): Promise<void> {
  const normalizedPath = path.join(qleverSource, 'src/parser/NormalizedString.h');
  const comparatorPath = path.join(qleverSource, 'src/index/StringSortComparator.h');
  const stringUtilsPath = path.join(qleverSource, 'src/util/StringUtils.h');
  await mkdir(path.dirname(normalizedPath), { recursive: true });
  await mkdir(path.dirname(comparatorPath), { recursive: true });
  await mkdir(path.dirname(stringUtilsPath), { recursive: true });
  await writeFile(normalizedPath, patchedNormalizedStringHeader, 'utf8');
  await writeFile(comparatorPath, patchedStringSortComparatorHeader, 'utf8');
  await writeFile(stringUtilsPath, patchedStringUtilsHeader, 'utf8');
}

describe('native QLever adapter CMake target', () => {
  it('keeps the local gtest_prod shim compatible with FRIEND_TEST access', () => {
    const shim = readFileSync(
      path.join(adapterRoot, 'src/gtest/gtest_prod.h'),
      'utf8',
    );

    expect(shim).toContain('friend class test_case_name##_##test_name##_Test');
  });

  it('configures and builds the adapter facade as a native library', async () => {
    expect(hasCmake(), 'cmake is required for native adapter build check').toBe(true);
    expect(existsSync(cmakeLists)).toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-adapter-cmake-'));
    try {
      const buildDir = path.join(root, 'build');
      execFileSync('cmake', ['-S', adapterRoot, '-B', buildDir], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
      execFileSync('cmake', ['--build', buildDir, '--target', 'xpod_qlever_adapter'], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, nativeBuildTimeoutMs);

  it('includes the CMake adapter build in the repository ABI check', () => {
    const scriptPath = path.join(repoRoot, 'qlever/scripts/check-rdf-physical-protocol-abi.cjs');
    const output = execFileSync(process.execPath, [scriptPath], { cwd: repoRoot, encoding: 'utf8' });
    expect(output).toContain('QLever adapter CMake target');
  }, nativeBuildTimeoutMs);

  it('has one static adapter artifact shape', () => {
    const cmake = readFileSync(cmakeLists, 'utf8');

    expect(cmake).toMatch(/add_library\(xpod_qlever_adapter\s+STATIC/);
    expect(cmake).not.toContain('XPOD_QLEVER_ADAPTER_BUILD_SHARED');
  });

  it('fails clearly when QLever mode is enabled without a source tree', async () => {
    expect(hasCmake(), 'cmake is required for native adapter build check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-adapter-source-required-'));
    try {
      const buildDir = path.join(root, 'build');
      let output = '';
      try {
        execFileSync('cmake', [
          '-S', adapterRoot,
          '-B', buildDir,
          '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON',
        ], {
          cwd: repoRoot,
          stdio: 'pipe',
        });
      } catch (error) {
        output = cmakeFailureOutput(error);
      }
      expect(output).toContain('XPOD_QLEVER_SOURCE_DIR is required');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, nativeBuildTimeoutMs);

  it('accepts an explicit QLever source tree when the required native headers exist', async () => {
    expect(hasCmake(), 'cmake is required for native adapter build check').toBe(true);
    expect(existsSync(qleverBridgeSource)).toBe(true);
    expect(readFileSync(cmakeLists, 'utf8')).toContain('src/XpodQleverBridge.cpp');
    expect(readFileSync(cmakeLists, 'utf8')).toContain('engine/Join.h');
    expect(readFileSync(cmakeLists, 'utf8')).toContain('engine/Operation.h');
    expect(readFileSync(cmakeLists, 'utf8')).toContain('engine/QueryExecutionTree.h');
    expect(readFileSync(cmakeLists, 'utf8')).toContain('util/CancellationHandle.h');
    expect(readFileSync(cmakeLists, 'utf8')).toContain('${CMAKE_CURRENT_SOURCE_DIR}/../include');
    expect(readFileSync(cmakeLists, 'utf8')).toContain('XPOD_QLEVER_ADAPTER_ENABLE_VECTOR=1');

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-adapter-source-present-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const dependencyIncludeDir = path.join(root, 'deps', 'include');
      await mkdir(path.join(dependencyIncludeDir, 'absl/types'), { recursive: true });
      await writeFile(path.join(dependencyIncludeDir, 'absl/types/compare.h'), '#pragma once\n', 'utf8');
      await mkdir(path.join(qleverSource, 'src/libqlever'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/parser'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine/idTable'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/global'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/index/EncodedIriManager.h'), fakeEncodedIriManagerHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/ExportIds.h'), fakeExportIdsHeader, 'utf8');
      await mkdir(path.join(qleverSource, 'src/util'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/util/MemorySize'), { recursive: true });
      await writePatchedLibcxxSources(qleverSource);
      await writeFile(path.join(qleverSource, 'src/libqlever/Qlever.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/ParsedQuery.h'), cmakeParsedQueryHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/ExternalValuesQuery.h'), '#pragma once\n#include "parser/ParsedQuery.h"\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/RdfParser.h'), fakeRdfParserHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlTriple.h'), fakeSparqlTripleHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/SparqlParser.h'), fakePermissiveSparqlParserHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/parser/TokenizerCtre.h'), fakeTokenizerCtreHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/util/CancellationHandle.h'), `
#pragma once
#include <stdexcept>
namespace ad_utility {
struct SharedCancellationHandle {};
class CancellationException : public std::runtime_error {
 public:
  CancellationException() : std::runtime_error("cancelled") {}
};
}
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/util/MemorySize/MemorySize.h'), `
#pragma once
namespace ad_utility {
class MemorySize {
 public:
  static MemorySize max() { return {}; }
};
}
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/util/AllocatorWithLimit.h'), `
#pragma once
#include <stdexcept>
#include "util/MemorySize/MemorySize.h"
namespace ad_utility {
namespace detail {
class AllocationExceedsLimitException : public std::runtime_error {
 public:
  AllocationExceedsLimitException() : std::runtime_error("memory limit") {}
};
}
template <typename T>
class AllocatorWithLimit {
 public:
  AllocatorWithLimit() = default;
};
template <typename T>
AllocatorWithLimit<T> makeUnlimitedAllocator() {
  return {};
}
}
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionContext.h'), abslDependentQueryExecutionContextHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionTree.h'), fakeQueryExecutionTreeHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Operation.h'), `
#pragma once
#include <string>
#include <utility>
#include <vector>
#include "engine/QueryExecutionTree.h"
#include "global/Id.h"
#include "parser/ParsedQuery.h"
class ExternalValues;
struct ColumnIndexAndTypeInfo { ColumnIndex columnIndex_; };
using VariableToColumnMap = std::vector<std::pair<Variable, ColumnIndexAndTypeInfo>>;
class Operation {
 public:
  virtual ~Operation() = default;
  virtual std::string getDescriptor() const { return ""; }
  virtual size_t getResultWidth() const { return 0; }
  const std::vector<ColumnIndex>& getResultSortedOn() const {
    sorted_cache_ = resultSortedOn();
    return sorted_cache_;
  }
  virtual std::vector<QueryExecutionTree*> getChildren() { return {}; }
  std::vector<const QueryExecutionTree*> getChildren() const { return {}; }
  virtual const VariableToColumnMap& getExternallyVisibleVariableColumns() const {
    static const VariableToColumnMap empty{};
    return empty;
  }
  virtual void getExternalValues(std::vector<ExternalValues*>&) {}
 protected:
  virtual std::vector<ColumnIndex> resultSortedOn() const { return {}; }
 private:
  mutable std::vector<ColumnIndex> sorted_cache_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/ExternalValues.h'), `
#pragma once
#include <string>
#include <utility>
#include "parser/ExternalValuesQuery.h"
class ExternalValues {
 public:
  const std::string& getName() const { return name_; }
  void updateValues(parsedQuery::SparqlValues values) {
    values_ = std::move(values);
  }
 private:
  std::string name_;
  parsedQuery::SparqlValues values_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryPlanner.h'), fakeQueryPlannerHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryPlanner.cpp'), patchedQueryPlannerSource, 'utf8');
      await writeFile(
        path.join(qleverSource, 'src/parser/TextSearchQuery.cpp'),
        patchedTextSearchQuerySource,
        'utf8',
      );
      await writeFile(path.join(qleverSource, 'src/engine/IndexScan.h'), fakeIndexScanHeader, 'utf8');
      await writeFile(
        path.join(qleverSource, 'src/engine/IndexScan.cpp'),
        'void xpod_overlay_marker() { (void)"materializedScanFromQleverScanSpecAndBlocks"; (void)"xpodIndexScanProjectedSlots"; (void)"lazyScanRangeFromQleverScanSpecAndBlocks"; (void)"!scanSpecAndBlocksIsPrefiltered_"; (void)"sizeEstimateFromQleverScanSpecAndBlocks"; (void)"exactSizeFromQleverScanSpecAndBlocks"; (void)"canUsePhysicalScanSpecAndBlocks"; }\n',
        'utf8',
      );
      await writeFile(
        path.join(qleverSource, 'src/engine/Filter.cpp'),
        patchedFilterSource,
        'utf8',
      );
      await writeFile(
        path.join(qleverSource, 'src/engine/GroupByImpl.cpp'),
        patchedGroupByImplSource,
        'utf8',
      );
      await writeFile(
        path.join(qleverSource, 'src/engine/OptionalJoin.cpp'),
        patchedOptionalJoinSource,
        'utf8',
      );
      await writeFile(
        path.join(qleverSource, 'src/engine/HasPredicateScan.cpp'),
        patchedHasPredicateScanSource,
        'utf8',
      );
      await writeFile(
        path.join(qleverSource, 'src/engine/TransitivePathImpl.h'),
        patchedTransitivePathImplHeader,
        'utf8',
      );
      await writeFile(
        path.join(qleverSource, 'src/engine/Values.cpp'),
        patchedValuesSource,
        'utf8',
      );
      await writeFile(
        path.join(qleverSource, 'src/engine/Describe.cpp'),
        patchedDescribeSource,
        'utf8',
      );
      await mkdir(path.join(qleverSource, 'src/engine/sparqlExpressions'), { recursive: true });
      await writeFile(
        path.join(qleverSource, 'src/engine/sparqlExpressions/SparqlExpressionValueGetters.cpp'),
        patchedExpressionValueGettersSource,
        'utf8',
      );
      await writeFile(
        path.join(qleverSource, 'src/engine/sparqlExpressions/StringExpressions.cpp'),
        patchedStringExpressionsSource,
        'utf8',
      );
      await writeFile(
        path.join(qleverSource, 'src/engine/sparqlExpressions/RegexExpression.cpp'),
        patchedRegexExpressionSource,
        'utf8',
      );
      await writeFile(
        path.join(qleverSource, 'src/engine/TextIndexScanForWord.cpp'),
        patchedTextIndexScanForWordSource,
        'utf8',
      );
      await writeFile(
        path.join(qleverSource, 'src/engine/TextIndexScanForEntity.cpp'),
        patchedTextIndexScanForEntitySource,
        'utf8',
      );
      await writeFile(path.join(qleverSource, 'src/engine/Join.h'), fakeJoinHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/idTable/IdTable.h'), `
#pragma once
#include <cstddef>
#include <vector>
#include "global/Id.h"
#include "util/AllocatorWithLimit.h"
class IdTable {
 public:
  IdTable(size_t width, ad_utility::AllocatorWithLimit<Id>) : width_(width) {}
  size_t numColumns() const { return width_; }
  size_t numRows() const { return rows_.size(); }
  void push_back(const std::vector<Id>& row) { rows_.push_back(row); }
  const Id& operator()(size_t row, size_t column) const { return rows_[row][column]; }
 private:
  size_t width_;
  std::vector<std::vector<Id>> rows_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/RuntimeInformation.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/Id.h'), `
#pragma once
#include <cstdint>
using ColumnIndex = uint64_t;
class Id {
 public:
  static Id fromBits(uint64_t bits) { return Id(bits); }
  uint64_t getBits() const { return bits_; }
  uint64_t bits_;
 private:
  explicit Id(uint64_t bits) : bits_(bits) {}
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/global/RuntimeParameters.h'), `
#pragma once
struct RuntimeParameters {
  bool stripColumns_ = false;
  bool disableCaching_ = false;
};
template <auto Parameter, typename Value>
void setRuntimeParameter(Value) {}
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/LocalVocab.h'), `
#pragma once
class LocalVocab {
 public:
  LocalVocab clone() const { return {}; }
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/Result.h'), `
#pragma once
#include <utility>
#include <vector>
#include "engine/idTable/IdTable.h"
#include "global/Id.h"
#include "index/LocalVocab.h"
class Result {
 public:
  Result(IdTable table, std::vector<ColumnIndex> sortedBy, LocalVocab&&)
      : table_(std::move(table)), sortedBy_(std::move(sortedBy)) {}
  const IdTable& idTable() const { return table_; }
  const std::vector<ColumnIndex>& sortedBy() const { return sortedBy_; }
 private:
  IdTable table_;
  std::vector<ColumnIndex> sortedBy_;
};
`, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Index.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/GraphFilter.h'), patchedGraphFilterHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/ScanSpecification.h'), patchedScanSpecificationHeader, 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
  explicit Permutation(Enum value = Enum::SPO) : value_(value) {}
  Enum permutation() const { return value_; }
 private:
  Enum value_;
};
`, 'utf8');

      await writeAdditionalOverlayMarkers(qleverSource);
      const buildDir = path.join(root, 'build');
      execFileSync('cmake', [
        '-S', adapterRoot,
        '-B', buildDir,
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON',
        '-DXPOD_QLEVER_ADAPTER_ENABLE_VECTOR=OFF',
        `-DXPOD_QLEVER_SOURCE_DIR=${qleverSource}`,
        `-DXPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS=${dependencyIncludeDir}`,
      ], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
      execFileSync('cmake', ['--build', buildDir, '--target', 'xpod_qlever_adapter'], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, nativeBuildTimeoutMs);

  it('treats upstream dependency include dirs as system headers', () => {
    const cmake = readFileSync(cmakeLists, 'utf8');
    expect(cmake).toContain('XPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS');
    expect(cmake).toMatch(/target_include_directories\(xpod_qlever_adapter\s+SYSTEM\s+PRIVATE\s+\$\{XPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS\}\)/);
  });

  it('gates both physical text-anchor planner overlays', () => {
    const cmake = readFileSync(cmakeLists, 'utf8');
    expect(cmake).toContain('bestPhysicalTextTermIndexFromContext');
    expect(cmake).toContain('src/engine/QueryPlanner.cpp');
    expect(cmake).toContain('src/parser/TextSearchQuery.cpp');
    expect(cmake).toContain('Xpod physical text-anchor planner overlay');
    expect(cmake).toContain('Xpod TextSearchQuery physical text-anchor overlay');
  });

  it('rejects a QLever source tree whose IndexScan lazy-scan overlay is missing', async () => {
    expect(hasCmake(), 'cmake is required for native adapter build check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-adapter-unpatched-source-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await writeRequiredQleverConfigureSkeleton(qleverSource, unpatchedIndexScanSource);

      let output = '';
      try {
        execFileSync('cmake', [
          '-S', adapterRoot,
          '-B', path.join(root, 'build'),
          '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON',
          `-DXPOD_QLEVER_SOURCE_DIR=${qleverSource}`,
        ], {
          cwd: repoRoot,
          stdio: 'pipe',
        });
      } catch (error) {
        output = cmakeFailureOutput(error);
      }
      expect(output).toContain('IndexScan.cpp is not patched with the Xpod lazy-scan overlay');
      expect(output).toContain('check-qlever-upstream-patches.cjs');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, nativeBuildTimeoutMs);

  it('rejects a QLever source tree whose QueryExecutionContext physical-index overlay is missing', async () => {
    expect(hasCmake(), 'cmake is required for native adapter build check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-adapter-unpatched-context-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await writeRequiredQleverConfigureSkeleton(
        qleverSource,
        'void xpod_overlay_marker() { (void)"materializedScanFromQleverScanSpecAndBlocks"; (void)"xpodIndexScanProjectedSlots"; (void)"lazyScanRangeFromQleverScanSpecAndBlocks"; (void)"!scanSpecAndBlocksIsPrefiltered_"; (void)"sizeEstimateFromQleverScanSpecAndBlocks"; (void)"exactSizeFromQleverScanSpecAndBlocks"; (void)"canUsePhysicalScanSpecAndBlocks"; }\n',
      );

      let output = '';
      try {
        execFileSync('cmake', [
          '-S', adapterRoot,
          '-B', path.join(root, 'build'),
          '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON',
          `-DXPOD_QLEVER_SOURCE_DIR=${qleverSource}`,
        ], {
          cwd: repoRoot,
          stdio: 'pipe',
        });
      } catch (error) {
        output = cmakeFailureOutput(error);
      }
      expect(output).toContain('QueryExecutionContext.h is not patched with the Xpod physical-index');
      expect(output).toContain('check-qlever-upstream-patches.cjs');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, nativeBuildTimeoutMs);

  it('rejects a QLever source tree whose QueryPlanner physical-index overlay is missing', async () => {
    expect(hasCmake(), 'cmake is required for native adapter build check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-adapter-unpatched-queryplanner-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await writeRequiredQleverConfigureSkeleton(
        qleverSource,
        'void xpod_overlay_marker() { (void)"materializedScanFromQleverScanSpecAndBlocks"; (void)"xpodIndexScanProjectedSlots"; (void)"lazyScanRangeFromQleverScanSpecAndBlocks"; (void)"!scanSpecAndBlocksIsPrefiltered_"; (void)"sizeEstimateFromQleverScanSpecAndBlocks"; (void)"exactSizeFromQleverScanSpecAndBlocks"; (void)"canUsePhysicalScanSpecAndBlocks"; }\n',
      );
      await writeFile(
        path.join(qleverSource, 'src/engine/QueryExecutionContext.h'),
        patchedQueryExecutionContextHeader,
        'utf8',
      );
      await writeFile(
        path.join(qleverSource, 'src/engine/QueryPlanner.cpp'),
        '#include "engine/QueryPlanner.h"\nvoid unpatched_queryplanner() { (void)"getIndex().hasAllPermutations()"; }\n',
        'utf8',
      );

      let output = '';
      try {
        execFileSync('cmake', [
          '-S', adapterRoot,
          '-B', path.join(root, 'build'),
          '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON',
          `-DXPOD_QLEVER_SOURCE_DIR=${qleverSource}`,
        ], {
          cwd: repoRoot,
          stdio: 'pipe',
        });
      } catch (error) {
        output = cmakeFailureOutput(error);
      }
      expect(output).toContain('QueryPlanner.cpp is not patched with the Xpod physical-index');
      expect(output).toContain('check-qlever-upstream-patches.cjs');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, nativeBuildTimeoutMs);

  it('rejects a QLever source tree whose Filter bounded-expression overlay is missing', async () => {
    expect(hasCmake(), 'cmake is required for native adapter build check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-adapter-unpatched-filter-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await writeRequiredQleverConfigureSkeleton(
        qleverSource,
        'void xpod_overlay_marker() { (void)"materializedScanFromQleverScanSpecAndBlocks"; (void)"xpodIndexScanProjectedSlots"; (void)"lazyScanRangeFromQleverScanSpecAndBlocks"; (void)"!scanSpecAndBlocksIsPrefiltered_"; (void)"sizeEstimateFromQleverScanSpecAndBlocks"; (void)"exactSizeFromQleverScanSpecAndBlocks"; (void)"canUsePhysicalScanSpecAndBlocks"; }\n',
      );
      await writeFile(
        path.join(qleverSource, 'src/engine/QueryExecutionContext.h'),
        patchedQueryExecutionContextHeader,
        'utf8',
      );
      await writeFile(
        path.join(qleverSource, 'src/engine/Filter.cpp'),
        unpatchedFilterSource,
        'utf8',
      );

      let output = '';
      try {
        execFileSync('cmake', [
          '-S', adapterRoot,
          '-B', path.join(root, 'build'),
          '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON',
          `-DXPOD_QLEVER_SOURCE_DIR=${qleverSource}`,
        ], {
          cwd: repoRoot,
          stdio: 'pipe',
        });
      } catch (error) {
        output = cmakeFailureOutput(error);
      }
      expect(output).toContain('src/engine/Filter.cpp is not patched');
      expect(output).toContain('Xpod Filter');
      expect(output).toContain('bounded-expression overlay');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, nativeBuildTimeoutMs);

  it('rejects a QLever source tree whose GroupBy physical-index optimization guard is missing', async () => {
    expect(hasCmake(), 'cmake is required for native adapter build check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-adapter-unpatched-groupby-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await writeRequiredQleverConfigureSkeleton(
        qleverSource,
        'void xpod_overlay_marker() { (void)"materializedScanFromQleverScanSpecAndBlocks"; (void)"xpodIndexScanProjectedSlots"; (void)"lazyScanRangeFromQleverScanSpecAndBlocks"; (void)"!scanSpecAndBlocksIsPrefiltered_"; (void)"sizeEstimateFromQleverScanSpecAndBlocks"; (void)"exactSizeFromQleverScanSpecAndBlocks"; (void)"canUsePhysicalScanSpecAndBlocks"; }\n',
      );
      await writeFile(
        path.join(qleverSource, 'src/engine/QueryExecutionContext.h'),
        patchedQueryExecutionContextHeader,
        'utf8',
      );
      await writeFile(
        path.join(qleverSource, 'src/engine/GroupByImpl.cpp'),
        unpatchedGroupByImplSource,
        'utf8',
      );

      let output = '';
      try {
        execFileSync('cmake', [
          '-S', adapterRoot,
          '-B', path.join(root, 'build'),
          '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON',
          `-DXPOD_QLEVER_SOURCE_DIR=${qleverSource}`,
        ], {
          cwd: repoRoot,
          stdio: 'pipe',
        });
      } catch (error) {
        output = cmakeFailureOutput(error);
      }
      expect(output).toContain('src/engine/GroupByImpl.cpp is not patched');
      expect(output).toContain('Xpod GroupBy');
      expect(output).toContain('physical-index optimization guard');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, nativeBuildTimeoutMs);

  it('rejects a QLever source tree whose OptionalJoin physical-index prefilter guard is missing', async () => {
    expect(hasCmake(), 'cmake is required for native adapter build check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-adapter-unpatched-optionaljoin-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await writeRequiredQleverConfigureSkeleton(
        qleverSource,
        'void xpod_overlay_marker() { (void)"materializedScanFromQleverScanSpecAndBlocks"; (void)"xpodIndexScanProjectedSlots"; (void)"lazyScanRangeFromQleverScanSpecAndBlocks"; (void)"!scanSpecAndBlocksIsPrefiltered_"; (void)"sizeEstimateFromQleverScanSpecAndBlocks"; (void)"exactSizeFromQleverScanSpecAndBlocks"; (void)"canUsePhysicalScanSpecAndBlocks"; }\n',
      );
      await writeFile(
        path.join(qleverSource, 'src/engine/QueryExecutionContext.h'),
        patchedQueryExecutionContextHeader,
        'utf8',
      );
      await writeFile(
        path.join(qleverSource, 'src/engine/OptionalJoin.cpp'),
        unpatchedOptionalJoinSource,
        'utf8',
      );

      let output = '';
      try {
        execFileSync('cmake', [
          '-S', adapterRoot,
          '-B', path.join(root, 'build'),
          '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON',
          `-DXPOD_QLEVER_SOURCE_DIR=${qleverSource}`,
        ], {
          cwd: repoRoot,
          stdio: 'pipe',
        });
      } catch (error) {
        output = cmakeFailureOutput(error);
      }
      expect(output).toContain('src/engine/OptionalJoin.cpp is not patched');
      expect(output).toContain('Xpod OptionalJoin');
      expect(output).toContain('physical-index prefilter guard');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, nativeBuildTimeoutMs);

  it('rejects a QLever source tree whose TextIndexScanForWord overlay is missing', async () => {
    expect(hasCmake(), 'cmake is required for native adapter build check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-adapter-unpatched-text-word-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await writeRequiredQleverConfigureSkeleton(
        qleverSource,
        'void xpod_overlay_marker() { (void)"materializedScanFromQleverScanSpecAndBlocks"; (void)"xpodIndexScanProjectedSlots"; (void)"lazyScanRangeFromQleverScanSpecAndBlocks"; (void)"!scanSpecAndBlocksIsPrefiltered_"; (void)"sizeEstimateFromQleverScanSpecAndBlocks"; (void)"exactSizeFromQleverScanSpecAndBlocks"; (void)"canUsePhysicalScanSpecAndBlocks"; }\n',
      );
      await writeFile(
        path.join(qleverSource, 'src/engine/QueryExecutionContext.h'),
        patchedQueryExecutionContextHeader,
        'utf8',
      );
      await writeFile(
        path.join(qleverSource, 'src/engine/TextIndexScanForWord.cpp'),
        '#include "engine/TextIndexScanForWord.h"\nvoid unpatched_text_word() {}\n',
        'utf8',
      );

      let output = '';
      try {
        execFileSync('cmake', [
          '-S', adapterRoot,
          '-B', path.join(root, 'build'),
          '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON',
          `-DXPOD_QLEVER_SOURCE_DIR=${qleverSource}`,
        ], {
          cwd: repoRoot,
          stdio: 'pipe',
        });
      } catch (error) {
        output = cmakeFailureOutput(error);
      }
      expect(output).toContain('src/engine/TextIndexScanForWord.cpp is not patched');
      expect(output).toContain('Xpod text-index');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, nativeBuildTimeoutMs);

  it('rejects a QLever source tree whose TextIndexScanForEntity overlay is missing', async () => {
    expect(hasCmake(), 'cmake is required for native adapter build check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-adapter-unpatched-text-entity-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await writeRequiredQleverConfigureSkeleton(
        qleverSource,
        'void xpod_overlay_marker() { (void)"materializedScanFromQleverScanSpecAndBlocks"; (void)"xpodIndexScanProjectedSlots"; (void)"lazyScanRangeFromQleverScanSpecAndBlocks"; (void)"!scanSpecAndBlocksIsPrefiltered_"; (void)"sizeEstimateFromQleverScanSpecAndBlocks"; (void)"exactSizeFromQleverScanSpecAndBlocks"; (void)"canUsePhysicalScanSpecAndBlocks"; }\n',
      );
      await writeFile(
        path.join(qleverSource, 'src/engine/QueryExecutionContext.h'),
        patchedQueryExecutionContextHeader,
        'utf8',
      );
      await writeFile(
        path.join(qleverSource, 'src/engine/TextIndexScanForEntity.cpp'),
        '#include "engine/TextIndexScanForEntity.h"\nvoid unpatched_text_entity() {}\n',
        'utf8',
      );

      let output = '';
      try {
        execFileSync('cmake', [
          '-S', adapterRoot,
          '-B', path.join(root, 'build'),
          '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON',
          `-DXPOD_QLEVER_SOURCE_DIR=${qleverSource}`,
        ], {
          cwd: repoRoot,
          stdio: 'pipe',
        });
      } catch (error) {
        output = cmakeFailureOutput(error);
      }
      expect(output).toContain('src/engine/TextIndexScanForEntity.cpp is not patched');
      expect(output).toContain('text-index entity');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, nativeBuildTimeoutMs);

  it('rejects a QLever source tree whose libc++ compatibility overlays are missing', async () => {
    expect(hasCmake(), 'cmake is required for native adapter build check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-adapter-unpatched-libcxx-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await writeRequiredQleverConfigureSkeleton(
        qleverSource,
        'void xpod_overlay_marker() { (void)"materializedScanFromQleverScanSpecAndBlocks"; (void)"xpodIndexScanProjectedSlots"; (void)"lazyScanRangeFromQleverScanSpecAndBlocks"; (void)"!scanSpecAndBlocksIsPrefiltered_"; (void)"sizeEstimateFromQleverScanSpecAndBlocks"; (void)"exactSizeFromQleverScanSpecAndBlocks"; (void)"canUsePhysicalScanSpecAndBlocks"; }\n',
      );
      await writeFile(
        path.join(qleverSource, 'src/engine/QueryExecutionContext.h'),
        patchedQueryExecutionContextHeader,
        'utf8',
      );
      await writeFile(
        path.join(qleverSource, 'src/parser/NormalizedString.h'),
        unpatchedNormalizedStringHeader,
        'utf8',
      );

      let output = '';
      try {
        execFileSync('cmake', [
          '-S', adapterRoot,
          '-B', path.join(root, 'build'),
          '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON',
          `-DXPOD_QLEVER_SOURCE_DIR=${qleverSource}`,
        ], {
          cwd: repoRoot,
          stdio: 'pipe',
        });
      } catch (error) {
        output = cmakeFailureOutput(error);
      }
      expect(output).toContain('src/parser/NormalizedString.h is not patched');
      expect(output).toContain('Xpod libc++');
      expect(output).toContain('check-qlever-upstream-patches.cjs');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, nativeBuildTimeoutMs);

  it('rejects a QLever source tree missing lower-level planner and index headers', async () => {
    expect(hasCmake(), 'cmake is required for native adapter build check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-adapter-source-incomplete-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/libqlever'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/libqlever/Qlever.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionContext.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/RuntimeInformation.h'), '#pragma once\n', 'utf8');

      let output = '';
      try {
        execFileSync('cmake', [
          '-S', adapterRoot,
          '-B', path.join(root, 'build'),
          '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON',
          `-DXPOD_QLEVER_SOURCE_DIR=${qleverSource}`,
        ], {
          cwd: repoRoot,
          stdio: 'pipe',
        });
      } catch (error) {
        output = cmakeFailureOutput(error);
      }
      expect(output).toContain('parser/SparqlParser.h');
      expect(output).toContain('parser/ParsedQuery.h');
      expect(output).toContain('parser/SparqlTriple.h');
      expect(output).toContain('engine/QueryPlanner.h');
      expect(output).toContain('engine/Join.h');
      expect(output).toContain('engine/Operation.h');
      expect(output).toContain('engine/QueryExecutionTree.h');
      expect(output).toContain('engine/Result.h');
      expect(output).toContain('engine/idTable/IdTable.h');
      expect(output).toContain('global/Id.h');
      expect(output).toContain('index/Index.h');
      expect(output).toContain('index/LocalVocab.h');
      expect(output).toContain('util/CancellationHandle.h');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, nativeBuildTimeoutMs);
});
