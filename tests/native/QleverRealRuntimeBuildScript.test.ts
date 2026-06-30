import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts/check-qlever-real-runtime.cjs');
const packageJsonPath = path.join(repoRoot, 'package.json');

describe('QLever real upstream runtime smoke script', () => {
  it('is exposed as a package script', () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['check:qlever-real-runtime']).toBe('node scripts/check-qlever-real-runtime.cjs');
  });

  it('prints a dry-run plan for building and running a real linked upstream smoke binary', () => {
    expect(existsSync(scriptPath)).toBe(true);
    const output = execFileSync('node', [
      scriptPath,
      '--qlever-source',
      path.join(repoRoot, '.test-data/qlever-upstream'),
      '--qlever-build-dir',
      path.join(repoRoot, '.test-data/qlever-full-build'),
      '--adapter-build-dir',
      path.join(repoRoot, '.test-data/qlever-real-adapter-build'),
      '--runtime-build-dir',
      path.join(repoRoot, '.test-data/qlever-real-runtime-build'),
      '--dry-run',
      '--json',
    ], { cwd: repoRoot, encoding: 'utf8' });

    const parsed = JSON.parse(output) as {
      fullEngineArgs: string[];
      realAdapterArgs: string[];
      libraryBuildArgs: string[];
      smokeSourcePath: string;
      smokeObjectPath: string;
      smokeBinaryPath: string;
      compileArgs: string[];
      linkLinePath: string;
      runArgs: string[];
    };
    expect(parsed.fullEngineArgs).toContain('scripts/check-qlever-full-engine-build.cjs');
    expect(parsed.fullEngineArgs).toContain('--target');
    expect(parsed.fullEngineArgs).toContain('engine');
    expect(parsed.libraryBuildArgs).toEqual(['--build', path.join(repoRoot, '.test-data/qlever-full-build'), '--target', 'parser', 'qlever', 'SortPerformanceEstimator', 'compilationInfo', '-j2']);
    expect(parsed.realAdapterArgs).toContain('scripts/check-qlever-real-adapter-build.cjs');
    expect(parsed.smokeSourcePath).toBe(path.join(repoRoot, '.test-data/qlever-real-runtime-build', 'xpod_qlever_real_runtime_smoke.cpp'));
    expect(parsed.smokeObjectPath).toBe(path.join(repoRoot, '.test-data/qlever-real-runtime-build', 'xpod_qlever_real_runtime_smoke.o'));
    expect(parsed.smokeBinaryPath).toBe(path.join(repoRoot, '.test-data/qlever-real-runtime-build', 'xpod_qlever_real_runtime_smoke'));
    expect(parsed.compileArgs.join('\n')).toContain('-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1');
    expect(parsed.compileArgs.join('\n')).toContain('native/postgres/qlever_adapter/include');
    expect(parsed.compileArgs).toContain(path.join(repoRoot, '.test-data/qlever-real-runtime-build', 'xpod_qlever_real_runtime_smoke.cpp'));
    expect(parsed.linkLinePath).toBe(path.join(repoRoot, '.test-data/qlever-full-build', 'CMakeFiles/qlever-server.dir/link.txt'));
    expect(parsed.runArgs).toEqual([path.join(repoRoot, '.test-data/qlever-real-runtime-build', 'xpod_qlever_real_runtime_smoke')]);
  });

  it('carries platform compiler flags from the QLever link line into the smoke compile step', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xpod-qlever-real-runtime-link-flags-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const qleverBuild = path.join(root, 'qlever-build');
      await mkdir(path.join(qleverSource, 'src'), { recursive: true });
      await mkdir(path.join(qleverBuild, 'CMakeFiles/qlever-server.dir'), { recursive: true });
      await writeFile(
        path.join(qleverBuild, 'CMakeFiles/qlever-server.dir/link.txt'),
        'clang++ -arch arm64 -isysroot /native/sdk CMakeFiles/qlever-server.dir/src/ServerMain.cpp.o -o qlever-server lib/libengine.a',
        'utf8',
      );

      const output = execFileSync('node', [
        scriptPath,
        '--qlever-source', qleverSource,
        '--qlever-build-dir', qleverBuild,
        '--adapter-build-dir', path.join(root, 'adapter-build'),
        '--runtime-build-dir', path.join(root, 'runtime-build'),
        '--dry-run',
        '--json',
      ], { cwd: repoRoot, encoding: 'utf8' });
      const parsed = JSON.parse(output) as { compileArgs: string[] };
      expect(parsed.compileArgs).toContain('-arch');
      expect(parsed.compileArgs).toContain('arm64');
      expect(parsed.compileArgs).toContain('-isysroot');
      expect(parsed.compileArgs).toContain('/native/sdk');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not link the server library into the adapter runtime smoke', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xpod-qlever-real-runtime-no-server-lib-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const qleverBuild = path.join(root, 'qlever-build');
      await mkdir(path.join(qleverSource, 'src'), { recursive: true });
      await mkdir(path.join(qleverBuild, 'CMakeFiles/qlever-server.dir'), { recursive: true });
      await writeFile(
        path.join(qleverBuild, 'CMakeFiles/qlever-server.dir/link.txt'),
        'clang++ CMakeFiles/qlever-server.dir/src/ServerMain.cpp.o -o qlever-server lib/libengine.a lib/libserver.a lib/libparser.a',
        'utf8',
      );

      const output = execFileSync('node', [
        scriptPath,
        '--qlever-source', qleverSource,
        '--qlever-build-dir', qleverBuild,
        '--adapter-build-dir', path.join(root, 'adapter-build'),
        '--runtime-build-dir', path.join(root, 'runtime-build'),
        '--dry-run',
        '--json',
      ], { cwd: repoRoot, encoding: 'utf8' });
      const parsed = JSON.parse(output) as { linkArgs: string[] };
      expect(parsed.linkArgs).not.toContain('lib/libserver.a');
      expect(parsed.linkArgs).toContain('lib/libengine.a');
      expect(parsed.linkArgs).toContain('lib/libparser.a');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes a real runtime smoke that exercises QLever text search through Xpod TEXT_SEARCH', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xpod-qlever-real-runtime-text-smoke-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const qleverBuild = path.join(root, 'qlever-build');
      const adapterBuild = path.join(root, 'adapter-build');
      const runtimeBuild = path.join(root, 'runtime-build');
      await mkdir(path.join(qleverSource, 'src'), { recursive: true });
      await mkdir(qleverBuild, { recursive: true });

      execFileSync('node', [
        scriptPath,
        '--qlever-source', qleverSource,
        '--qlever-build-dir', qleverBuild,
        '--adapter-build-dir', adapterBuild,
        '--runtime-build-dir', runtimeBuild,
        '--skip-prerequisites',
        '--configure-only',
      ], { cwd: repoRoot, encoding: 'utf8' });

      const smoke = readFileSync(path.join(runtimeBuild, 'xpod_qlever_real_runtime_smoke.cpp'), 'utf8');
      expect(smoke).toContain('text_search');
      expect(smoke).toContain('estimate_text_search');
      expect(smoke).toContain('estimate_distinct');
      expect(smoke).toContain('ql:contains-word');
      expect(smoke).toContain('ql:contains-entity <urn:entity>');
      expect(smoke).toContain('lookup_terms');
      expect(smoke).toContain('urn:text');
      expect(smoke).toContain('urn:entity');
      expect(smoke).toContain('request->required_entities[0] != 60');
      expect(smoke).toContain('state.text_calls');
      expect(smoke).toContain('state.entity_text_calls');
      expect(smoke).toContain('state.entity_text_estimate_calls');
      expect(smoke).toContain('state.estimate_distinct_calls');
      expect(smoke).toContain('SELECT ?s ?tail WHERE { ?s ?p ?o . ?o ?p2 ?tail }');
      expect(smoke).toContain('urn:tail');
      expect(smoke).toContain('join_scan_calls');
      expect(smoke).toContain('join_scan_calls < 1');
      expect(smoke).toContain('join_estimate_distinct_calls < 1');
      expect(smoke).toContain('"head":{"vars":["s","tail"]}');
      expect(smoke).toContain('SELECT DISTINCT ?s WHERE { ?s ?p ?o } ORDER BY ?s LIMIT 1');
      expect(smoke).toContain('modifier_scan_calls');
      expect(smoke).toContain('modifier_json.find(R"("head":{"vars":["s"]})")');
      expect(smoke).toContain('modifier_json.find("urn:o") != std::string_view::npos');
      expect(smoke).toContain('modifier_profile.find("OrderBy")');
      expect(smoke).toContain('SELECT DISTINCT ?x WHERE { { ?x ?p ?o } UNION { ?s ?p2 ?x } } ORDER BY ?x');
      expect(smoke).toContain('union_profile.find("Union")');
      expect(smoke).toContain('SELECT ?s ?tail WHERE { ?s ?p ?o OPTIONAL { ?o ?p2 ?tail } } ORDER BY ?s LIMIT 1');
      expect(smoke).toContain('optional_profile.find("OptionalJoin")');
      expect(smoke).toContain('optional_profile.find("LimitOffset")');
      expect(smoke).toContain('SELECT ?s WHERE { ?s ?p ?o MINUS { ?s <urn:p2> ?tail } }');
      expect(smoke).toContain('minus_profile.find("Minus")');
      expect(smoke).toContain('SELECT ?s WHERE { VALUES ?s { <urn:s> <urn:o> } ?s ?p ?o } ORDER BY ?s');
      expect(smoke).toContain('values_profile.find("Values")');
      expect(smoke).toContain('values_json.find("urn:tail") != std::string_view::npos');
      expect(smoke).toContain('SELECT ?s ?o WHERE { ?s ?p ?o FILTER(?o != <urn:tail>) } ORDER BY ?s');
      expect(smoke).toContain('filter_profile.find("Filter")');
      expect(smoke).toContain('filter_json.find("urn:tail") != std::string_view::npos');
      expect(smoke).toContain('SELECT ?s ?o WHERE { ?s ?p ?o FILTER(?o = <urn:o>) } ORDER BY ?s');
      expect(smoke).toContain('equal_filter_profile.find("Filter")');
      expect(smoke).toContain('equal_filter_json.find("urn:tail") != std::string_view::npos');
      expect(smoke).toContain('SELECT ?s ?o WHERE { ?s ?p ?o FILTER(?o = \\"literal-value\\") } ORDER BY ?s');
      expect(smoke).toContain('literal_filter_profile.find("Filter")');
      expect(smoke).toContain('literal_filter_json.find("literal-value")');
      expect(smoke).toContain('SELECT ?s ?o WHERE { ?s ?p ?o FILTER(\\"literal-value\\" = ?o) } ORDER BY ?s');
      expect(smoke).toContain('literal_left_filter_profile.find("Filter")');
      expect(smoke).toContain('literal_left_filter_json.find("literal-value")');
      expect(smoke).toContain('ASK { ?s ?p ?o }');
      expect(smoke).toContain('ask_json.find(R"("boolean":true)")');
      expect(smoke).toContain('ask_profile.find("Ask")');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails clearly when the upstream source tree is not supplied', () => {
    let output = '';
    try {
      execFileSync('node', [scriptPath, '--dry-run'], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
      output = [failure.stdout, failure.stderr, failure.message]
        .filter(Boolean)
        .map((value) => Buffer.isBuffer(value) ? value.toString('utf8') : String(value))
        .join('\n');
    }
    expect(output).toContain('missing --qlever-source or XPOD_QLEVER_SOURCE_DIR');
  });
});
