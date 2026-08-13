#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const DEFAULT_TARGETS = [
  'HasPredicateScanTest',
  'PropertyPathTest',
  'ValuesTest',
  'TransitivePathTest',
  'TextIndexScanForWordTest',
  'TextIndexScanForEntityTest',
  'IndexScanTest',
  'IndexTest',
  'GraphNameManagerTest',
  'LocatedTriplesTest',
  'DeltaTriplesTest',
  'JoinTest',
  'UnionTest',
  'MultiColumnJoinTest',
  'MinusTest',
  'SortTest',
  'OrderByTest',
  'GroupByTest',
  'DistinctTest',
  'OptionalJoinTest',
  'CartesianProductJoinTest',
  'FilterTest',
  'ExistsJoinTest',
  'RegexExpressionTest',
  'OperationTest',
  'LazyGroupByTest',
  'TextLimitOperationTest',
  'LimitOffsetClauseTest',
  'QueryPlannerTest',
  'QueryPlannerSpatialJoinTest',
  'RuntimeInformationTest',
  'SparqlExpressionTest',
  'SparqlExpressionMemberFunctionsTest',
  'RelationalExpressionTest',
  'AggregateExpressionTest',
  'BindTest',
  'DescribeTest',
  'GroupByHashMapOptimizationTest',
  'NeutralOptionalTest',
  'QueryExecutionTreeTest',
  'ExportQueryExecutionTreesTest',
  'ServiceTest',
  'ExplicitIdTableOperationTest',
  'ConstructTripleInstantiatorTest',
  'ConstructTripleGeneratorTest',
  'CountConnectedSubgraphsTest',
  'SelectClauseTest',
  'SparqlParserTest',
  'TripleComponentTest',
  'SparqlAntlrParserTest',
  'SparqlAntlrParserExpressionTest',
  'GraphPatternOperationTest',
  'GraphPatternAnalysisTest',
  'BlankNodeExpressionTest',
  'PayloadVariablesTest',
  'NamedCachedResultTest',
  'LiteralOrIriTest',
  'GraphTermTest',
  'ConstructTemplatePreprocessorTest',
  'ConstructBatchEvaluatorTest',
  'ConstructDeduplicationModeTest',
  'ExportIdsTest',
  'ResultTest',
  'ResultTableColumnOperationsTest',
  'VariableToColumnMapTest',
  'StripColumnsTest',
  'PermutationSelectorTest',
  'ScanSpecificationTest',
  'ExternalValuesTest',
  'ExternalValuesQueryTest',
  'LoadTest',
  'PathSearchTest',
  'ExecuteUpdateTest',
  'GraphStoreProtocolTest',
  'SparqlProtocolTest',
  'ParsedRequestBuilderTest',
  'MaterializedViewsTest',
  'MaterializedViewsStarRewriteTest',
  'UpdateFetcherTest',
  'UpdateMetadataTest',
  'UpdateTriplesTest',
  'SparqlAntlrParserUpdateTest',
  'QueryRewriteUtilTest',
  'GetPrefilterExpressionFromSparqlExpressionTest',
  'PrefilterExpressionIndexTest',
  'IndexMetaDataTest',
  'EncodedIriManagerTest',
  'LocalVocabTest',
  'ValueGetterTest',
  'ValueIdTest',
  'ValueIdComparatorsTest',
  'VariableCounterTest',
  'UrlParserTest',
  'ExceptionHandlingTest',
  'StringUtilsTest',
  'ConstexprSmallStringTest',
  'CryptographicHashUtilsTest',
  'BenchmarkMeasurementContainerTest',
  'ServerTest',
  'CacheTest',
  'ConcurrentCacheTest',
  'FileTest',
  'Simple8bTest',
  'WordsAndDocsFileParserTest',
  'IdTripleTest',
  'ZipMergeUniqueViewTest',
  'IdTableUtilsTest',
  'HashMapTest',
  'StringPairHashMapTest',
  'HashSetTest',
  'VocabularyGeneratorTest',
  'MmapVectorTest',
  'BufferedVectorTest',
  'RdfParserTest',
  'IdTableTest',
  'TransitivePathGraphSearchTest',
  'BatchedPipelineTest',
  'TupleHelpersTest',
  'UriParserUriTest',
  'ParsedUriTest',
  'StringSortComparatorTest',
  'PriorityQueueTest',
  'SynchronizedTest',
  'AllocatorWithLimitTest',
  'AlignedAllocatorTest',
  'SortPerformanceEstimatorTest',
  'SerializerTest',
  'ParametersTest',
  'ZstdCompressionTest',
  'TaskQueueTest',
  'SetOfIntervalsTest',
  'TypeTraitsTest',
  'StreamableBodyTest',
  'StreamableGeneratorTest',
  'StringBatcherTest',
  'AcceptHeaderTest',
  'CompactStringVectorTest',
  'SparqlDataTypesTest',
  'ContentEncodingHelperTest',
  'PrefixCompressorTest',
  'VocabularyTest',
  'IteratorTest',
  'ViewsTest',
  'TakeUntilInclusiveViewTest',
  'ForwardTest',
  'CompressorStreamTest',
  'AsyncStreamTest',
  'BitUtilsTest',
  'NBitIntegerTest',
  'GeoPointTest',
  'GeoSparqlHelpersTest',
  'HttpUtilsTest',
  'DateYearDurationTest',
  'DurationTest',
  'LambdaHelpersTest',
  'ParseExceptionTest',
  'TransparentFunctorsTest',
  'CheckUsePatternTrickTest',
  'HttpTest',
  'CallFixedSizeTest',
  'ConstexprUtilsTest',
  'ResetWhenMovedTest',
  'TimerTest',
  'AlgorithmTest',
  'CompressedRelationsTest',
  'ExceptionTest',
  'RandomExpressionTest',
  'NowDatetimeExpressionTest',
  'LanguageExpressionsTest',
  'ValuesForTestingTest',
  'OnDestructionDontThrowDuringStackUnwindingTest',
  'SparqlExpressionTypesTest',
  'CopyableUniquePtrTest',
  'JsonCustomConverterForThirdPartyTest',
  'ConfigManagerTest',
  'ConfigOptionTest',
  'ValidatorTest',
  'ConfigOptionProxyTest',
  'ConfigUtilTest',
  'RandomTest',
  'FindUndefRangesTest',
  'AddCombinedRowToTableTest',
  'CtreHelpersTest',
  'ComparisonWithNanTest',
  'ThreadSafeQueueTest',
  'IdTableHelpersTest',
  'GeneratorTest',
  'MemorySizeTest',
  'JsonUtilTest',
  'JoinAlgorithmsTest',
  'AsioHelpersTest',
  'UniqueCleanupTest',
  'WebSocketSessionTest',
  'QueryIdTest',
  'QueryHubTest',
  'QueryToSocketDistributorTest',
  'MessageSenderTest',
  'CancellationHandleTest',
  'ProgressBarTest',
  'CachingMemoryResourceTest',
  'ParallelMultiwayMergeTest',
  'ParseableDurationTest',
  'ConstantsTest',
  'JThreadTest',
  'ChunkedForLoopTest',
  'FsstCompressorTest',
  'CopyableSynchronizationTest',
  'LazyJsonParserTest',
  'GeneratorsTest',
  'BlankNodeManagerTest',
  'SparqlExpressionGeneratorsTest',
  'LruCacheTest',
  'LruCacheWithStatisticsTest',
  'InputRangeUtilsTest',
  'TripleSerializerTest',
  'GeometryInfoTest',
  'HttpErrorTest',
  'TimeTracerTest',
  'SourceLocationTest',
  'UnitOfMeasurementTest',
  'ConstexprMapTest',
  'ParallelExecutorTest',
  'IoUringManagerTest',
  'VariantRangeFilterTest',
  'EnumWithStringsTest',
  'FilesystemHelpersTest',
  'LogTest',
  'QueryEventLogTest',
  'ConceptsTest',
  'ShiftTest',
  'ValueIdentityTest',
  'BackportIteratorTest',
  'StartsWithTest',
  'EndsWithTest',
  'FunctionalTest',
  'ThreeWayComparisonTest',
  'AtomicFlagTest',
  'SpatialJoinTest',
  'SpatialJoinAlgorithmsTest',
  'SpatialJoinPrefilterTest',
  'SpatialJoinParserTest',
  'SpatialJoinCachedIndexTest',
  'GroupConcatExpressionTest',
  'NamedResultCacheTest',
  'NamedResultCacheSerializerTest',
  'StringMappingTest',
  'CompressedExternalIdTableTest',
  'PatternCreatorTest',
  'KeyOrderTest',
  'IndexRebuilderTest',
  'InputFileSpecificationTest',
  'VocabularyMergerImplTest',
  'VocabularyInMemoryTest',
  'VocabularyOnDiskTest',
  'CompressedVocabularyTest',
  'UnicodeVocabularyTest',
  'VocabularyInternalExternalTest',
  'VocabularyInMemoryBinSearchTest',
  'PolymorphicVocabularyTest',
  'VocabularyTypeTest',
  'GeoVocabularyTest',
  'SplitVocabularyTest',
  'VocabularyTypesTest',
  'JoinColumnMappingTest',
  'QleverTest',
  'ParallelBufferTest',
  'QuadTest',
  'VariableTest',
  'RdfEscapingTest',
];
const KNOWN_BLOCKED_TARGETS = [];
const TARGET_PROFILES = {
  'core-engine': [
    'JoinTest',
    'UnionTest',
    'OptionalJoinTest',
    'FilterTest',
    'GroupByTest',
  ],
  'query-surface': [
    'HasPredicateScanTest',
    'PropertyPathTest',
    'ValuesTest',
    'TransitivePathTest',
    'TextIndexScanForWordTest',
    'TextIndexScanForEntityTest',
    'IndexScanTest',
    'ExistsJoinTest',
    'DescribeTest',
    'ConstructTripleGeneratorTest',
    'ServiceTest',
    'GraphStoreProtocolTest',
    'ExecuteUpdateTest',
    'SparqlProtocolTest',
    'ParsedRequestBuilderTest',
  ],
};
const TEST_BINARY_DIRS = {
  PropertyPathTest: ['test', 'parser'],
  TextIndexScanForWordTest: ['test', 'engine'],
  TextIndexScanForEntityTest: ['test', 'engine'],
};
const TEST_TARGET_DECLARATION_PATTERN =
  String.raw`(?:addLinkAndDiscoverTest(?:NoLibs|Serial|SerialNoLibs)?|addLinkAndRunAsSingleTest|addAndLinkTest)\s*\(\s*([A-Za-z0-9_]+)(?:\s|\)|$)`;

function fail(message, error) {
  console.error(`[qlever-upstream-subset-tests] ${message}`);
  if (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function maybeAdd(args, cmakeName, value) {
  if (value) {
    args.push(`-${cmakeName}=${value}`);
  }
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}


function hostArchitectureToken() {
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'x64') return 'x86_64';
  return process.arch;
}

function pkgConfigOutput(args) {
  return execFileSync('pkg-config', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function pkgConfigJemalloc() {
  try {
    const flags = pkgConfigOutput(['--libs-only-L', 'jemalloc']);
    const libdir = pkgConfigOutput(['--variable=libdir', 'jemalloc']);
    const dylib = path.join(libdir, 'libjemalloc.dylib');
    if (process.platform === 'darwin' && fileExists(dylib)) {
      const info = execFileSync('file', [dylib], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (!info.includes(hostArchitectureToken())) {
        return { flags: undefined, compatible: false };
      }
    }
    return { flags: flags || undefined, compatible: true };
  } catch {
    return { flags: undefined, compatible: true };
  }
}

function defaultPkgConfigLibdir(jemalloc) {
  if (process.env.PKG_CONFIG_LIBDIR || jemalloc.compatible) {
    return undefined;
  }
  if (process.platform === 'darwin' && fileExists('/opt/homebrew')) {
    return [
      '/opt/homebrew/lib/pkgconfig',
      '/opt/homebrew/share/pkgconfig',
    ].join(':');
  }
  return undefined;
}

function defaultHomebrewPrefixPath() {
  if (process.env.XPOD_QLEVER_CMAKE_PREFIX_PATH) {
    return process.env.XPOD_QLEVER_CMAKE_PREFIX_PATH;
  }
  if (process.platform !== 'darwin' || !fileExists('/opt/homebrew')) {
    return undefined;
  }
  return [
    '/opt/homebrew',
    '/opt/homebrew/opt/icu4c',
    '/opt/homebrew/opt/openssl@3',
    '/opt/homebrew/opt/boost',
  ].filter(fileExists).join(';') || undefined;
}

function defaultIcuRoot() {
  if (process.env.XPOD_QLEVER_ICU_ROOT) {
    return process.env.XPOD_QLEVER_ICU_ROOT;
  }
  const homebrewIcu = '/opt/homebrew/opt/icu4c';
  return process.platform === 'darwin' && fileExists(homebrewIcu)
    ? homebrewIcu
    : undefined;
}

function defaultCompiler(name) {
  const envName = name === 'C' ? 'XPOD_QLEVER_CMAKE_C_COMPILER' : 'XPOD_QLEVER_CMAKE_CXX_COMPILER';
  if (process.env[envName]) return process.env[envName];
  const homebrew = name === 'C'
    ? '/opt/homebrew/opt/llvm/bin/clang'
    : '/opt/homebrew/opt/llvm/bin/clang++';
  if (process.platform === 'darwin' && fileExists(homebrew)) return homebrew;
  return undefined;
}

function darwinLlvmLibcxxFlags() {
  const libcxxDir = '/opt/homebrew/opt/llvm/lib/c++';
  if (process.platform !== 'darwin' || !fileExists(libcxxDir)) {
    return [];
  }
  return [`-L${libcxxDir}`, `-Wl,-rpath,${libcxxDir}`, '-lc++'];
}

function defaultExecutableLinkerFlags(jemalloc) {
  const explicit = process.env.XPOD_QLEVER_UPSTREAM_TEST_CMAKE_EXE_LINKER_FLAGS ||
    process.env.XPOD_QLEVER_CMAKE_EXE_LINKER_FLAGS;
  if (explicit) return explicit;
  return [...darwinLlvmLibcxxFlags(), jemalloc.compatible ? jemalloc.flags : undefined]
    .filter(Boolean)
    .join(' ') || undefined;
}

function selectedProfile() {
  return readArg('--profile') || process.env.XPOD_QLEVER_UPSTREAM_TEST_PROFILE;
}

function resolveTargets(qleverSource) {
  const raw = readArg('--targets') || process.env.XPOD_QLEVER_UPSTREAM_TEST_TARGETS;
  if (raw) {
    if (raw.trim() === 'all') return { targets: discoverCmakeTestTargets(qleverSource), profile: undefined };
    return {
      targets: raw.split(',').map((value) => value.trim()).filter(Boolean),
      profile: undefined,
    };
  }
  const profile = selectedProfile();
  if (!profile) return { targets: DEFAULT_TARGETS, profile: undefined };
  const targets = TARGET_PROFILES[profile];
  if (!targets) {
    fail(`unknown upstream test profile: ${profile}`);
  }
  return { targets, profile };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function listCmakeFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listCmakeFiles(fullPath));
    } else if (entry.isFile() && entry.name === 'CMakeLists.txt') {
      files.push(fullPath);
    }
  }
  return files;
}

function cmakeBinaryDirForTarget(sourceDir, target) {
  const testRoot = path.join(sourceDir, 'test');
  const pattern = new RegExp(
    TEST_TARGET_DECLARATION_PATTERN.replace('([A-Za-z0-9_]+)', escapeRegex(target)),
  );
  for (const cmakeFile of listCmakeFiles(testRoot)) {
    const content = fs.readFileSync(cmakeFile, 'utf8');
    if (!pattern.test(content)) continue;
    const relativeDir = path.relative(sourceDir, path.dirname(cmakeFile));
    return relativeDir.split(path.sep).filter(Boolean);
  }
  return undefined;
}

function discoverCmakeTestTargets(sourceDir) {
  const testRoot = path.join(sourceDir, 'test');
  const pattern = new RegExp(TEST_TARGET_DECLARATION_PATTERN, 'g');
  const targets = [];
  const seen = new Set();
  for (const cmakeFile of listCmakeFiles(testRoot)) {
    const content = fs.readFileSync(cmakeFile, 'utf8');
    for (const match of content.matchAll(pattern)) {
      const target = match[1];
      if (!target || seen.has(target)) continue;
      seen.add(target);
      targets.push(target);
    }
  }
  return targets;
}

function binaryPathForTarget(buildDir, target, sourceDir) {
  const parts = cmakeBinaryDirForTarget(sourceDir, target) || TEST_BINARY_DIRS[target] || ['test'];
  return path.join(buildDir, ...parts, target);
}

const sourceInput = readArg('--qlever-source') || process.env.XPOD_QLEVER_SOURCE_DIR;
if (!sourceInput) {
  fail('missing --qlever-source or XPOD_QLEVER_SOURCE_DIR');
}

const qleverSource = path.resolve(sourceInput);
if (!fs.existsSync(qleverSource)) {
  fail(`QLever source tree does not exist: ${qleverSource}`);
}
const buildDir = path.resolve(
  readArg('--qlever-build-dir') || readArg('--build-dir') || process.env.XPOD_QLEVER_FULL_BUILD_DIR ||
    path.join(repoRoot, '.test-data/qlever-full-build'),
);
const jobs = readArg('--jobs') || process.env.XPOD_QLEVER_UPSTREAM_TEST_JOBS || '2';
const dryRun = hasFlag('--dry-run');
const json = hasFlag('--json');
const upstreamDiscoveredTargets = discoverCmakeTestTargets(qleverSource);
const resolvedSelection = resolveTargets(qleverSource);
const targets = resolvedSelection.targets;
const jemalloc = pkgConfigJemalloc();
const pkgConfigLibdir = defaultPkgConfigLibdir(jemalloc);
const cmakeEnv = pkgConfigLibdir
  ? { ...process.env, PKG_CONFIG_LIBDIR: pkgConfigLibdir }
  : process.env;

const patchCheckArgs = [
  process.execPath,
  path.join('scripts', 'check-qlever-upstream-patches.cjs'),
  '--qlever-source',
  qleverSource,
];

const xpodIncludeFlags = [
  '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1',
  `-I${path.join(repoRoot, 'qlever_adapter/src')}`,
  `-I${path.join(repoRoot, 'qlever_adapter/include')}`,
  `-I${path.join(repoRoot, 'rdf_protocol/include')}`,
].join(' ');

const configureArgs = [
  '-S', qleverSource,
  '-B', buildDir,
  '-DCMAKE_BUILD_TYPE=Release',
  '-DCHEAPER_COMPILATION=ON',
  '-DUSE_PRECOMPILED_HEADERS=OFF',
  '-DUSE_IO_URING=OFF',
  `-DCMAKE_CXX_FLAGS=${xpodIncludeFlags}`,
  '-UJEMALLOC_*',
  '-Upkgcfg_lib_JEMALLOC_*',
];
maybeAdd(configureArgs, 'DCMAKE_C_COMPILER', defaultCompiler('C'));
maybeAdd(configureArgs, 'DCMAKE_CXX_COMPILER', defaultCompiler('CXX'));
maybeAdd(configureArgs, 'DCMAKE_PREFIX_PATH', defaultHomebrewPrefixPath());
maybeAdd(configureArgs, 'DCMAKE_EXE_LINKER_FLAGS', defaultExecutableLinkerFlags(jemalloc));
maybeAdd(configureArgs, 'DICU_ROOT', defaultIcuRoot());
maybeAdd(configureArgs, 'DBoost_DIR', process.env.XPOD_QLEVER_BOOST_DIR);

const tests = targets.map((target) => {
  const binary = binaryPathForTarget(buildDir, target, qleverSource);
  return {
    target,
    binary,
    runCwd: path.join(repoRoot, '.test-data/qlever-upstream-subset-runs', target),
    buildArgs: ['--build', buildDir, '--target', target, `-j${jobs}`],
    runArgs: [binary, '--gtest_brief=1'],
  };
});

const coverage = {
  status: resolvedSelection.profile
    ? 'profile'
    : upstreamDiscoveredTargets.every((target) => targets.includes(target)) && KNOWN_BLOCKED_TARGETS.length === 0
    ? 'complete'
    : 'partial',
  profile: resolvedSelection.profile,
  selectedTargets: targets,
  upstreamDiscoveredTargets,
  unselectedDiscoveredTargets: upstreamDiscoveredTargets.filter((target) => !targets.includes(target)),
  knownBlockedTargets: KNOWN_BLOCKED_TARGETS,
};

if (dryRun) {
  const payload = {
    patchCheckArgs: patchCheckArgs.slice(1),
    configureArgs,
    configureEnv: pkgConfigLibdir ? { PKG_CONFIG_LIBDIR: pkgConfigLibdir } : {},
    coverage,
    tests,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    console.log('[qlever-upstream-subset-tests] patch:', patchCheckArgs.join(' '));
    console.log('[qlever-upstream-subset-tests] configure:', ['cmake', ...configureArgs].join(' '));
    console.log('[qlever-upstream-subset-tests] coverage:', `${coverage.status}; ${coverage.selectedTargets.length} selected target(s), ${coverage.knownBlockedTargets.length} known blocked target(s)`);
    for (const test of tests) {
      console.log('[qlever-upstream-subset-tests] build:', ['cmake', ...test.buildArgs].join(' '));
      console.log('[qlever-upstream-subset-tests] run:', test.runArgs.join(' '));
    }
  }
  process.exit(0);
}

try {
  execFileSync(patchCheckArgs[0], patchCheckArgs.slice(1), { cwd: repoRoot, stdio: 'inherit' });
  execFileSync('cmake', configureArgs, { cwd: repoRoot, stdio: 'inherit', env: cmakeEnv });
  for (const test of tests) {
    execFileSync('cmake', test.buildArgs, { cwd: repoRoot, stdio: 'inherit' });
    if (!fs.existsSync(test.binary)) {
      fail(`expected upstream test binary was not produced: ${test.binary}`);
    }
    fs.mkdirSync(test.runCwd, { recursive: true });
    execFileSync(test.runArgs[0], test.runArgs.slice(1), { cwd: test.runCwd, stdio: 'inherit' });
  }
} catch (error) {
  fail('upstream QLever subset tests failed', error);
}

console.log(`[qlever-upstream-subset-tests] OK: ran ${targets.length} upstream test target(s): ${targets.join(', ')}`);
if (coverage.knownBlockedTargets.length > 0) {
  console.log(`[qlever-upstream-subset-tests] Coverage: ${coverage.status}; ${coverage.knownBlockedTargets.length} known upstream target(s) remain outside the default gate.`);
}
