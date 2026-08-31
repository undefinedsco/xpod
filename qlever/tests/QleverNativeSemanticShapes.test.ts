import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { cleanQleverEnv } from './qleverTestEnv';

const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'qlever/scripts/check-qlever-real-runtime.cjs');
const bridgeSource = path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverBridge.cpp');
const executorFactoryTest = path.join(repoRoot, 'qlever/tests/QleverExecutorFactory.test.ts');
const repoLocalQleverSource = path.join(repoRoot, 'qlever/.test-data/qlever-upstream');

const representativeShapes = [
  {
    name: 'join',
    profileVariable: 'join_profile',
    operation: 'Join',
    resultEvidence: ['"head":{"vars":["s","tail"]}', 'urn:s', 'urn:tail'],
  },
  {
    name: 'filter',
    profileVariable: 'filter_profile',
    operation: 'Filter',
    resultEvidence: ['"head":{"vars":["s","o"]}', 'urn:s', 'urn:o'],
  },
  {
    name: 'optional',
    profileVariable: 'optional_profile',
    operation: 'OptionalJoin',
    resultEvidence: ['"head":{"vars":["s","tail"]}', 'urn:s', 'urn:tail'],
  },
  {
    name: 'union',
    profileVariable: 'union_profile',
    operation: 'Union',
    resultEvidence: ['"head":{"vars":["x"]}', 'urn:s', 'urn:o', 'urn:tail'],
  },
  {
    name: 'minus',
    profileVariable: 'minus_profile',
    operation: 'Minus',
    resultEvidence: ['"head":{"vars":["s"]}', 'urn:s'],
  },
  {
    name: 'group aggregate',
    profileVariable: 'distinct_scalar_count_profile',
    operation: 'GroupBy',
    resultEvidence: ['"head":{"vars":["count"]}', '"value":"7"'],
  },
  {
    name: 'order limit',
    profileVariable: 'modifier_profile',
    operation: 'OrderBy',
    resultEvidence: ['"head":{"vars":["s"]}', 'urn:s'],
  },
  {
    name: 'property path',
    profileVariable: 'zero_or_more_path_profile',
    operation: 'TransitivePath',
    resultEvidence: ['"head":{"vars":["o"]}', 'urn:s', 'urn:o'],
  },
] as const;

function makeRuntimeSmoke(root: string): string {
  const qleverSource = path.join(root, 'qlever');
  const qleverBuild = path.join(root, 'qlever-build');
  const adapterBuild = path.join(root, 'adapter-build');
  const runtimeBuild = path.join(root, 'runtime-build');
  execFileSync('node', [
    scriptPath,
    '--qlever-source', qleverSource,
    '--qlever-build-dir', qleverBuild,
    '--adapter-build-dir', adapterBuild,
    '--runtime-build-dir', runtimeBuild,
    '--skip-prerequisites',
    '--configure-only',
  ], { cwd: repoRoot, encoding: 'utf8', env: cleanQleverEnv() });
  return readFileSync(path.join(runtimeBuild, 'xpod_qlever_real_runtime_smoke.cpp'), 'utf8');
}

function realQleverSource(): string | undefined {
  if (existsSync(repoLocalQleverSource)) {
    return repoLocalQleverSource;
  }
  if (process.env.XPOD_QLEVER_SOURCE_DIR && existsSync(process.env.XPOD_QLEVER_SOURCE_DIR)) {
    return process.env.XPOD_QLEVER_SOURCE_DIR;
  }
  return undefined;
}

describe('QLever native semantic representative shapes', () => {
  it('generates NativeOnly public C ABI runtime checks for representative relational shapes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xpod-qlever-native-shapes-'));
    try {
      await mkdir(path.join(root, 'qlever/src'), { recursive: true });
      const smoke = makeRuntimeSmoke(root);

      expect(smoke).toContain('xpod_qlever_adapter_config config = {};');
      expect(smoke).toContain('config.backend = &raw_backend;');
      expect(smoke).not.toContain(
        'config.execution_policy = XPOD_QLEVER_EXECUTION_COMPATIBILITY_ALLOWED;',
      );
      expect(smoke).toContain('assert_native_shape_profile(');
      expect(smoke).toContain('"executionMode":"native-qlever-tree"');
      expect(smoke).toContain('runtimeInformation');
      expect(smoke).toContain('BridgeOperation');
      expect(smoke).toContain('compatibility-');

      for (const shape of representativeShapes) {
        expect(smoke).toMatch(
          new RegExp(
            `assert_native_shape_profile\\(\\s*"${shape.name}",\\s*${shape.profileVariable},\\s*"${shape.operation}"`,
            'u',
          ),
        );
        for (const evidence of shape.resultEvidence) {
          expect(smoke).toContain(evidence);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps historical compatibility fixtures explicit and native-only failures closed', () => {
    const factory = readFileSync(executorFactoryTest, 'utf8');
    const compatibilityFixture = factory.slice(
      factory.indexOf('xpod_qlever_adapter_config config = {};', factory.indexOf('qec_cache_modes.clear();')),
      factory.indexOf('xpod_qlever_adapter_release_result(adapter, &result);', factory.indexOf('qec_cache_modes.clear();')),
    );
    expect(compatibilityFixture).toContain(
      'config.execution_policy = XPOD_QLEVER_EXECUTION_COMPATIBILITY_ALLOWED;',
    );

    const bridge = readFileSync(bridgeSource, 'utf8');
    const nativeOnlyStart = bridge.indexOf('xpod_rdf_status executeNativeQleverQueryWithPlannerContext(');
    const nativeOnlyEnd = bridge.indexOf('xpod_rdf_status executeBridgeQueryWithPlannerContext(', nativeOnlyStart);
    const nativeOnlyBody = bridge.slice(nativeOnlyStart, nativeOnlyEnd);
    expect(nativeOnlyBody).toContain('ExecutionMode::NativeQleverTree');
    expect(nativeOnlyBody).toContain('native-qlever-tree-unavailable');
    expect(nativeOnlyBody).toContain('XPOD_RDF_STATUS_UNSUPPORTED');
    expect(nativeOnlyBody).not.toContain('executeBridgeQueryWithPlannerContext(');
    expect(nativeOnlyBody).not.toContain('planBridgeParsedQuery(');
    expect(nativeOnlyBody).not.toContain('planParsedGraphPatternFallback(');
  });

  const linkedRuntimeIt = realQleverSource() === undefined ? it.skip : it;
  linkedRuntimeIt('can run the real linked runtime semantic smoke when an upstream QLever source is configured', () => {
    const qleverSource = realQleverSource();
    if (qleverSource === undefined) {
      throw new Error('linked runtime test registered without a QLever source');
    }
    const buildRoot = path.join(repoRoot, '.test-data/phase2-task5');

    execFileSync('node', [
      scriptPath,
      '--qlever-source', qleverSource,
      '--qlever-build-dir', path.join(buildRoot, 'qlever-build'),
      '--adapter-build-dir', path.join(buildRoot, 'adapter-build'),
      '--runtime-build-dir', path.join(buildRoot, 'runtime-build'),
      '--relational-shapes-only',
      '--jobs', '2',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: cleanQleverEnv(),
      stdio: 'pipe',
      timeout: 900_000,
    });
  }, 900_000);
});
