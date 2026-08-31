import { chmodSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { cleanQleverEnv } from './qleverTestEnv';

const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'qlever/scripts/check-qlever-upstream-subset-tests.cjs');
const packageJsonPath = path.join(repoRoot, 'package.json');
let qleverSource = process.env.XPOD_QLEVER_SOURCE_DIR ?? '';
let generatedQleverSource = '';

beforeAll(async () => {
  if (qleverSource) {
    return;
  }
  generatedQleverSource = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-source-layout-'));
  qleverSource = generatedQleverSource;

  const script = readFileSync(scriptPath, 'utf8');
  const defaultTargets = script
    .match(/const DEFAULT_TARGETS = \[([\s\S]*?)\n\];/u)?.[1]
    .match(/'[^']+'/gu)
    ?.map((target) => target.slice(1, -1));
  if (!defaultTargets?.length) {
    throw new Error('Unable to read DEFAULT_TARGETS from the upstream subset runner');
  }

  const nestedTargets = new Map<string, string[]>([
    ['engine', ['IndexScanTest', 'TextIndexScanForWordTest']],
    ['joinAlgorithms', ['JoinColumnMappingTest']],
    ['parser', ['PropertyPathTest']],
  ]);
  const nestedNames = new Set([...nestedTargets.values()].flat());
  await mkdir(path.join(qleverSource, 'test'), { recursive: true });
  await writeFile(
    path.join(qleverSource, 'test', 'CMakeLists.txt'),
    defaultTargets
      .filter((target) => !nestedNames.has(target))
      .map((target) => `addLinkAndDiscoverTest(${target})`)
      .join('\n'),
    'utf8',
  );
  for (const [directory, targets] of nestedTargets) {
    const targetDirectory = path.join(qleverSource, 'test', directory);
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(
      path.join(targetDirectory, 'CMakeLists.txt'),
      targets.map((target) => `addLinkAndDiscoverTest(${target})`).join('\n'),
      'utf8',
    );
  }
});

afterAll(async () => {
  if (generatedQleverSource) {
    await rm(generatedQleverSource, { recursive: true, force: true });
  }
});

describe('QLever upstream subset test script', () => {
  it('is exposed as a package script', () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['check:qlever-upstream-subset-tests']).toBe('node qlever/scripts/check-qlever-upstream-subset-tests.cjs');
  });

  it('prints the selected upstream semantic test targets without running them', () => {
    const output = execFileSync('node', [
      scriptPath,
      '--qlever-source',
      qleverSource,
      '--qlever-build-dir',
      path.join(repoRoot, '.test-data/qlever-full-build'),
      '--dry-run',
      '--json',
    ], { cwd: repoRoot, encoding: 'utf8', env: cleanQleverEnv() });

    const parsed = JSON.parse(output) as {
      patchCheckArgs: string[];
      configureArgs: string[];
      coverage?: {
        status: string;
        selectedTargets: string[];
        upstreamDiscoveredTargets: string[];
        unselectedDiscoveredTargets: string[];
        knownBlockedTargets: Array<{ target: string; reason: string }>;
      };
      tests: Array<{ target: string; binary: string; runArgs: string[]; runCwd: string }>;
    };

    expect(parsed.patchCheckArgs).toContain('scripts/check-qlever-upstream-patches.cjs');
    expect(parsed.configureArgs.join('\n')).toContain('-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1');
    expect(parsed.configureArgs.join('\n')).toContain('qlever/qlever_adapter/src');
    expect(parsed.coverage?.status).toBe('complete');
    expect(parsed.coverage?.selectedTargets).toContain('IndexScanTest');
    expect(parsed.coverage?.upstreamDiscoveredTargets.length).toBe(parsed.coverage?.selectedTargets.length);
    expect(parsed.coverage?.unselectedDiscoveredTargets).toEqual([]);
    expect(parsed.coverage?.selectedTargets).toContain('ServiceTest');
    expect(parsed.coverage?.knownBlockedTargets).not.toContainEqual({
      target: 'ServiceTest',
      reason: expect.any(String),
    });
    expect(parsed.coverage?.selectedTargets).toContain('ParsedRequestBuilderTest');
    expect(parsed.coverage?.knownBlockedTargets).not.toContainEqual({
      target: 'ParsedRequestBuilderTest',
      reason: expect.any(String),
    });
    expect(parsed.coverage?.selectedTargets).toContain('SparqlProtocolTest');
    expect(parsed.coverage?.knownBlockedTargets).not.toContainEqual({
      target: 'SparqlProtocolTest',
      reason: expect.any(String),
    });
    expect(parsed.coverage?.selectedTargets).toContain('IndexTest');
    expect(parsed.coverage?.knownBlockedTargets).not.toContainEqual({
      target: 'IndexTest',
      reason: expect.any(String),
    });
    expect(parsed.coverage?.selectedTargets).toContain('GraphNameManagerTest');
    expect(parsed.coverage?.knownBlockedTargets).not.toContainEqual({
      target: 'GraphNameManagerTest',
      reason: expect.any(String),
    });
    expect(parsed.coverage?.selectedTargets).toContain('LocatedTriplesTest');
    expect(parsed.coverage?.knownBlockedTargets).not.toContainEqual({
      target: 'LocatedTriplesTest',
      reason: expect.any(String),
    });
    expect(parsed.coverage?.selectedTargets).toContain('DeltaTriplesTest');
    expect(parsed.coverage?.knownBlockedTargets).not.toContainEqual({
      target: 'DeltaTriplesTest',
      reason: expect.any(String),
    });
    expect(parsed.coverage?.selectedTargets).toContain('TripleComponentTest');
    expect(parsed.coverage?.knownBlockedTargets).not.toContainEqual({
      target: 'TripleComponentTest',
      reason: expect.any(String),
    });
    expect(parsed.coverage?.knownBlockedTargets).toEqual([]);
    expect(parsed.tests.map((test) => test.target)).toEqual([
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
    ]);
    expect(parsed.tests[0]?.binary).toBe(path.join(repoRoot, '.test-data/qlever-full-build', 'test', 'HasPredicateScanTest'));
    expect(parsed.tests[0]?.runArgs).toEqual([
      path.join(repoRoot, '.test-data/qlever-full-build', 'test', 'HasPredicateScanTest'),
      '--gtest_brief=1',
    ]);
    expect(parsed.tests[0]?.runCwd).toBe(path.join(repoRoot, 'qlever/.test-data/qlever-upstream-subset-runs', 'HasPredicateScanTest'));
  });

  it('maps nested upstream test target binaries to their CMake output directories', () => {
    const output = execFileSync('node', [
      scriptPath,
      '--qlever-source',
      qleverSource,
      '--qlever-build-dir',
      path.join(repoRoot, '.test-data/qlever-full-build'),
      '--targets',
      'TextIndexScanForWordTest,PropertyPathTest',
      '--dry-run',
      '--json',
    ], { cwd: repoRoot, encoding: 'utf8', env: cleanQleverEnv() });

    const parsed = JSON.parse(output) as {
      tests: Array<{ target: string; binary: string; runArgs: string[]; runCwd: string }>;
    };

    expect(parsed.tests.map((test) => test.target)).toEqual([
      'TextIndexScanForWordTest',
      'PropertyPathTest',
    ]);
    expect(parsed.tests[0]?.binary).toBe(path.join(repoRoot, '.test-data/qlever-full-build', 'test', 'engine', 'TextIndexScanForWordTest'));
    expect(parsed.tests[0]?.runArgs[0]).toBe(parsed.tests[0]?.binary);
    expect(parsed.tests[1]?.binary).toBe(path.join(repoRoot, '.test-data/qlever-full-build', 'test', 'parser', 'PropertyPathTest'));
  });

  it('offers a core-engine profile for repeatable upstream semantic smoke', () => {
    const output = execFileSync('node', [
      scriptPath,
      '--qlever-source',
      qleverSource,
      '--qlever-build-dir',
      path.join(repoRoot, '.test-data/qlever-full-build'),
      '--profile',
      'core-engine',
      '--dry-run',
      '--json',
    ], { cwd: repoRoot, encoding: 'utf8', env: cleanQleverEnv() });

    const parsed = JSON.parse(output) as {
      coverage?: { status: string };
      tests: Array<{ target: string }>;
    };

    expect(parsed.coverage?.status).toBe('profile');
    expect(parsed.tests.map((test) => test.target)).toEqual([
      'JoinTest',
      'UnionTest',
      'OptionalJoinTest',
      'FilterTest',
      'GroupByTest',
    ]);
  });

  it('offers a query-surface profile for linked QLever product coverage', () => {
    const output = execFileSync('node', [
      scriptPath,
      '--qlever-source',
      qleverSource,
      '--qlever-build-dir',
      path.join(repoRoot, '.test-data/qlever-full-build'),
      '--profile',
      'query-surface',
      '--dry-run',
      '--json',
    ], { cwd: repoRoot, encoding: 'utf8', env: cleanQleverEnv() });

    const parsed = JSON.parse(output) as {
      coverage?: { status: string; profile?: string };
      tests: Array<{ target: string }>;
    };

    expect(parsed.coverage?.status).toBe('profile');
    expect(parsed.coverage?.profile).toBe('query-surface');
    expect(parsed.tests.map((test) => test.target)).toEqual([
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
    ]);
  });

  it('infers upstream test binary directories from nested CMakeLists targets', () => {
    const output = execFileSync('node', [
      scriptPath,
      '--qlever-source',
      qleverSource,
      '--qlever-build-dir',
      path.join(repoRoot, '.test-data/qlever-full-build'),
      '--targets',
      'IndexScanTest,JoinColumnMappingTest,PropertyPathTest',
      '--dry-run',
      '--json',
    ], { cwd: repoRoot, encoding: 'utf8', env: cleanQleverEnv() });

    const parsed = JSON.parse(output) as {
      tests: Array<{ target: string; binary: string; runArgs: string[]; runCwd: string }>;
    };

    expect(parsed.tests.map((test) => test.binary)).toEqual([
      path.join(repoRoot, '.test-data/qlever-full-build', 'test', 'engine', 'IndexScanTest'),
      path.join(repoRoot, '.test-data/qlever-full-build', 'test', 'joinAlgorithms', 'JoinColumnMappingTest'),
      path.join(repoRoot, '.test-data/qlever-full-build', 'test', 'parser', 'PropertyPathTest'),
    ]);
  });

  it('discovers all upstream test targets from CMakeLists when targets is all', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-all-targets-'));
    try {
      const engineDir = path.join(root, 'test', 'engine');
      const parserDir = path.join(root, 'test', 'parser');
      await mkdir(engineDir, { recursive: true });
      await mkdir(parserDir, { recursive: true });
      await writeFile(path.join(root, 'test', 'CMakeLists.txt'), `
addLinkAndDiscoverTest(RootTest)
addLinkAndDiscoverTest(RootTest)
`, 'utf8');
      await writeFile(path.join(engineDir, 'CMakeLists.txt'), `
addLinkAndDiscoverTest(EngineTest)
addLinkAndDiscoverTestNoLibs(EngineNoLibsTest)
`, 'utf8');
      await writeFile(path.join(parserDir, 'CMakeLists.txt'), `
addAndLinkTest(ParserTest)
addLinkAndRunAsSingleTest(ParserSingleTest)
`, 'utf8');

      const output = execFileSync('node', [
        scriptPath,
        '--qlever-source',
        root,
        '--qlever-build-dir',
        path.join(root, 'build'),
        '--targets',
        'all',
        '--dry-run',
        '--json',
      ], { cwd: repoRoot, encoding: 'utf8', env: cleanQleverEnv() });

      const parsed = JSON.parse(output) as {
        coverage?: {
          status: string;
          upstreamDiscoveredTargets: string[];
          unselectedDiscoveredTargets: string[];
        };
        tests: Array<{ target: string; binary: string }>;
      };

      expect(parsed.coverage?.upstreamDiscoveredTargets).toEqual([
        'RootTest',
        'EngineTest',
        'EngineNoLibsTest',
        'ParserTest',
        'ParserSingleTest',
      ]);
      expect(parsed.coverage?.unselectedDiscoveredTargets).toEqual([]);
      expect(parsed.coverage?.status).toBe('complete');
      expect(parsed.tests.map((test) => test.target)).toEqual([
        'RootTest',
        'EngineTest',
        'EngineNoLibsTest',
        'ParserTest',
        'ParserSingleTest',
      ]);
      expect(parsed.tests[1]?.binary).toBe(path.join(root, 'build', 'test', 'engine', 'EngineTest'));
      expect(parsed.tests[3]?.binary).toBe(path.join(root, 'build', 'test', 'parser', 'ParserTest'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('adds the Homebrew LLVM libc++ runtime path for Darwin upstream test binaries', () => {
    const output = execFileSync('node', [
      scriptPath,
      '--qlever-source',
      qleverSource,
      '--dry-run',
      '--json',
    ], { cwd: repoRoot, encoding: 'utf8', env: cleanQleverEnv() });

    const parsed = JSON.parse(output) as { configureArgs: string[] };
    if (process.platform === 'darwin') {
      expect(parsed.configureArgs.join('\n')).toContain('/opt/homebrew/opt/llvm/lib/c++');
      expect(parsed.configureArgs.join('\n')).toContain('-lc++');
    }
  });


  it('quarantines architecture-incompatible jemalloc pkg-config results', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-subset-bad-jemalloc-'));
    try {
      const libdir = path.join(root, 'lib');
      await mkdir(libdir, { recursive: true });
      await writeFile(path.join(libdir, 'libjemalloc.dylib'), 'not a native library', 'utf8');
      const fakePkgConfig = path.join(root, 'pkg-config');
      await writeFile(fakePkgConfig, `#!/bin/sh
if [ "$1" = "--libs-only-L" ] && [ "$2" = "jemalloc" ]; then
  echo "-L${libdir}"
  exit 0
fi
if [ "$1" = "--variable=libdir" ] && [ "$2" = "jemalloc" ]; then
  echo "${libdir}"
  exit 0
fi
exit 1
`, 'utf8');
      chmodSync(fakePkgConfig, 0o755);

      const output = execFileSync('node', [
        scriptPath,
        '--qlever-source',
        qleverSource,
        '--dry-run',
        '--json',
      ], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: cleanQleverEnv({ PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}` }),
      });

      const parsed = JSON.parse(output) as { configureEnv?: Record<string, string> };
      if (process.platform === 'darwin') {
        expect(parsed.configureEnv?.PKG_CONFIG_LIBDIR).toBe('/opt/homebrew/lib/pkgconfig:/opt/homebrew/share/pkgconfig');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails clearly when the upstream source tree is not supplied', () => {
    let output = '';
    try {
      const env = cleanQleverEnv();
      execFileSync('node', [scriptPath, '--dry-run'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
        env,
      });
    } catch (error) {
      const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
      output = [failure.stdout, failure.stderr, failure.message]
        .filter(Boolean)
        .map((value) => Buffer.isBuffer(value) ? value.toString('utf8') : String(value))
        .join('\n');
    }
    expect(output).toContain('missing --qlever-source or XPOD_QLEVER_SOURCE_DIR');
  });

  it('fails clearly when dry-run coverage is requested for a missing upstream source tree', () => {
    let output = '';
    try {
      execFileSync('node', [
        scriptPath,
        '--qlever-source',
        path.join(os.tmpdir(), 'xpod-missing-qlever-source-tree'),
        '--dry-run',
        '--json',
      ], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe', env: cleanQleverEnv() });
    } catch (error) {
      const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
      output = [failure.stdout, failure.stderr, failure.message]
        .filter(Boolean)
        .map((value) => Buffer.isBuffer(value) ? value.toString('utf8') : String(value))
        .join('\n');
    }
    expect(output).toContain('QLever source tree does not exist');
  });
});
