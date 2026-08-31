import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { cleanQleverEnv } from './qleverTestEnv';

const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'qlever/scripts/check-qlever-real-runtime.cjs');
const packageJsonPath = path.join(repoRoot, 'package.json');

async function generateSmokeSource(rootPrefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), rootPrefix));
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
    ], { cwd: repoRoot, encoding: 'utf8', env: cleanQleverEnv() });

    return readFileSync(path.join(runtimeBuild, 'xpod_qlever_real_runtime_smoke.cpp'), 'utf8');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('QLever real upstream runtime smoke script', () => {
  it('is exposed as a package script', () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['check:qlever-real-runtime']).toBe('node qlever/scripts/check-qlever-real-runtime.cjs');
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
    ], { cwd: repoRoot, encoding: 'utf8', env: cleanQleverEnv() });

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
    expect(parsed.compileArgs.join('\n')).toContain('qlever/qlever_adapter/include');
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
      ], { cwd: repoRoot, encoding: 'utf8', env: cleanQleverEnv() });
      const parsed = JSON.parse(output) as { compileArgs: string[] };
      expect(parsed.compileArgs).toContain('-arch');
      expect(parsed.compileArgs).toContain('arm64');
      expect(parsed.compileArgs).toContain('-isysroot');
      expect(parsed.compileArgs).toContain('/native/sdk');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('defers real smoke compile/link args until after prerequisite builds refresh QLever metadata', () => {
    const source = readFileSync(scriptPath, 'utf8');
    expect(source).not.toContain('const compileArgs = makeCompileArgs(');
    expect(source).toContain('const runtimePlan = makeSmokePlan(');
    expect(source.indexOf('const runtimePlan = makeSmokePlan('))
      .toBeGreaterThan(source.indexOf("execFileSync(process.execPath, realAdapterArgs"));
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
      ], { cwd: repoRoot, encoding: 'utf8', env: cleanQleverEnv() });
      const parsed = JSON.parse(output) as { linkArgs: string[] };
      expect(parsed.linkArgs).not.toContain('lib/libserver.a');
      expect(parsed.linkArgs).toContain('lib/libengine.a');
      expect(parsed.linkArgs).toContain('lib/libparser.a');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('locks the canonical offset dateTime ordering counterexample into the real runtime smoke', async () => {
    const smoke = await generateSmokeSource('xpod-qlever-real-runtime-datetime-contract-');

    expect(smoke).toContain('kTimeEarlyLexical = "2026-08-28T23:30:00+12:00"');
    expect(smoke).toContain('kTimeLateLexical = "2026-08-28T12:00:00Z"');
    expect(smoke).toContain('kTimeLateOpaqueKey = 8000');
    expect(smoke).toContain('kTimeEarlyOpaqueKey = 8100');
    expect(smoke).toContain('state.time_rows_enabled = true');
    expect(smoke).toContain('SELECT ?s ?time WHERE { ?s <urn:time> ?time } ORDER BY ?time');
    expect(smoke).toContain('const size_t early_pos = stored_datetime_order_json.find("urn:time-early")');
    expect(smoke).toContain('const size_t late_pos = stored_datetime_order_json.find("urn:time-late")');
    expect(smoke).toContain('early_pos < late_pos');
    expect(smoke).toContain('stored dateTime order mismatch');
    expect(smoke).toContain('"stored dateTime order"');
    expect(smoke).toContain('stored_datetime_order_profile');
    expect(smoke).toContain('"OrderBy"');
    expect(smoke).toContain('1270');
    expect(smoke).toContain('FILTER(?time >= \\"2026-08-28T11:45:00Z\\"^^');
    expect(smoke).toContain('<http://www.w3.org/2001/XMLSchema#dateTime>)');
    expect(smoke).toContain('inline_datetime_filter_json.find("urn:time-late")');
    expect(smoke).toContain('inline_datetime_filter_json.find(kTimeLateLexical)');
    expect(smoke).toContain('inline_datetime_filter_json.find("urn:time-early")');
    expect(smoke).toContain('inline_datetime_filter_json.find(kTimeEarlyLexical)');
    expect(smoke).toContain('inline dateTime filter mismatch');
    expect(smoke).toContain('"inline dateTime filter"');
    expect(smoke).toContain('inline_datetime_filter_profile');
    expect(smoke).toContain('"Filter"');
    expect(smoke).toContain('1300');
  });

  it('locks mixed implicit default graph plus GRAPH union scan evidence into the real runtime smoke', async () => {
    const smoke = await generateSmokeSource('xpod-qlever-real-runtime-mixed-graph-contract-');

    expect(smoke).toContain('default_graph_scope_before_mixed_union');
    expect(smoke).not.toContain('exact_graph_scope_before_mixed_union');
    expect(smoke).toContain('BIND(<urn:xpod:semantic:g:default> AS ?g) } UNION');
    expect(smoke).toContain('{ GRAPH ?g { ?s <urn:p> ?o } }');
    expect(smoke).toContain('R"("g":{"type":"uri","value":"urn:xpod:semantic:g:default"})"');
    expect(smoke).toContain('R"("g":{"type":"uri","value":"urn:g"})"');
    expect(smoke).toContain('mixed default/named UNION missing one branch');
    expect(smoke).toContain('return 1244;');
    expect(smoke).toContain('return 1245;');
    expect(smoke).toContain('state.default_graph_scope_scans <=');
    expect(smoke).toContain('mixed default/named UNION did not scan the QLever default graph exactly');
    expect(smoke).toContain('return 1246;');
    expect(smoke).not.toContain('state.exact_graph_scope_scans <= exact_graph_scope_before_mixed_union');
    expect(smoke).not.toContain('mixed default/named UNION did not scan the named graph exactly');
    expect(smoke).toContain('"mixed default/named union"');
    expect(smoke).toContain('mixed_default_named_union_profile');
    expect(smoke).toContain('"Union"');
    expect(smoke).toContain('1240');
  });

  it('models production opaque ids without claiming native scan order', async () => {
    const smoke = await generateSmokeSource('xpod-qlever-real-runtime-id-contract-');

    expect(smoke).toContain(
      'raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_OPAQUE;',
    );
    expect(smoke).toContain(
      'raw_backend.qlever_term_ordering = XPOD_RDF_QLEVER_TERM_ORDER_UNKNOWN;',
    );
    expect(smoke).not.toContain(
      'raw_backend.term_key_encoding = XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS;',
    );
    expect(smoke).not.toContain(
      'raw_backend.qlever_term_ordering = XPOD_RDF_QLEVER_TERM_ORDER_PRESERVED;',
    );
    expect(smoke).toContain(
      'Id::makeFromVocabIndex(VocabIndex::make(term)).getBits()',
    );
    expect(smoke).toContain(
      'Id::makeFromBlankNodeIndex(BlankNodeIndex::make(term)).getBits()',
    );
    expect(smoke).toContain('id.getVocabIndex().get()');
    expect(smoke).toContain('id.getBlankNodeIndex().get()');
    expect(smoke).not.toContain('*out_bits = term;');
    expect(smoke).not.toContain('*out_term = bits;');
    expect(smoke).not.toContain('raw_backend.compare_qlever_ids =');
  });

  it('drops inherited jemalloc linker flags when the library is not present', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xpod-qlever-real-runtime-no-jemalloc-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      const qleverBuild = path.join(root, 'qlever-build');
      await mkdir(path.join(qleverSource, 'src'), { recursive: true });
      await mkdir(path.join(qleverBuild, 'CMakeFiles/qlever-server.dir'), { recursive: true });
      const missingLibDir = path.join(root, 'missing-lib');
      await mkdir(missingLibDir, { recursive: true });
      await writeFile(
        path.join(qleverBuild, 'CMakeFiles/qlever-server.dir/link.txt'),
        `clang++ CMakeFiles/qlever-server.dir/src/ServerMain.cpp.o -o qlever-server -L${missingLibDir} -ljemalloc lib/libengine.a lib/libparser.a`,
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
      ], { cwd: repoRoot, encoding: 'utf8', env: cleanQleverEnv() });
      const parsed = JSON.parse(output) as { linkArgs: string[] };
      expect(parsed.linkArgs).not.toContain('-ljemalloc');
      expect(parsed.linkArgs).toContain('lib/libengine.a');
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
      ], { cwd: repoRoot, encoding: 'utf8', env: cleanQleverEnv() });

      const smoke = readFileSync(path.join(runtimeBuild, 'xpod_qlever_real_runtime_smoke.cpp'), 'utf8');
      expect(smoke).toContain('text_search');
      expect(smoke).toContain('estimate_text_search');
      expect(smoke).toContain('estimate_distinct');
      expect(smoke).toContain('XPOD_RDF_BACKEND_FEATURE_BLOCK_METADATA');
      expect(smoke).toContain('XPOD_RDF_BACKEND_FEATURE_BLOCK_RESTRICTED_SCAN');
      expect(smoke).toContain('static xpod_rdf_status scan_block_metadata');
      expect(smoke).toContain('raw_backend.scan_block_metadata = scan_block_metadata');
      expect(smoke).toContain('request->offset');
      expect(smoke).toContain('request->limit');
      expect(smoke).toContain('ql:contains-word');
      expect(smoke).toContain('ql:contains-entity <urn:entity>');
      expect(smoke).toContain('lookup_terms');
      expect(smoke).toContain(
        'http://qlever.cs.uni-freiburg.de/builtin-functions/default-graph',
      );
      expect(smoke).toContain('kDefaultGraphKey');
      expect(smoke).toContain('{10, 20, 30, kDefaultGraphKey}');
      expect(smoke).toContain('static bool matches_access_scope(');
      expect(smoke).toContain(
        'if (!matches_access_scope(request->access_scope, row)) continue;',
      );
      expect(smoke).toContain(
        'if (!matches_access_scope(request->scan.access_scope, row)) continue;',
      );
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
      expect(smoke).toContain('SELECT ?s WHERE { { SELECT ?s WHERE { ?s <urn:p> ?o } } } ORDER BY ?s');
      expect(smoke).toContain('subquery_profile');
      expect(smoke).toContain('SELECT ?s FROM <urn:g> WHERE { ?s <urn:p> ?o } ORDER BY ?s');
      expect(smoke).toContain('exact_graph_scope_scans');
      expect(smoke).toContain('FROM graph did not reach backend as exact graph scope');
      expect(smoke).toContain('xpod_qlever_adapter_destroy(adapter);');
      expect(smoke).toContain('SELECT ?s WHERE { ?s ?p ?o } ORDER BY STR(?s) LIMIT 1');
      expect(smoke).toContain('order_by_str_profile');
      expect(smoke).toContain('modifier_scan_calls');
      expect(smoke).toContain('modifier_json.find(R"("head":{"vars":["s"]})")');
      expect(smoke).toContain('modifier_json.find(R"("s":{"type":"uri")")');
      expect(smoke).toContain('modifier_json.find(R"("s":{"type":"uri","value":"urn:o"})") != std::string_view::npos');
      expect(smoke).toContain('modifier_profile.find("OrderBy")');
      expect(smoke).toContain('#include "global/Id.h"');
      expect(smoke).toContain('static xpod_rdf_term_key stored_numeric_key(int64_t value)');
      expect(smoke).toContain('kIntegerOneOpaqueKey = 8201');
      expect(smoke).toContain('kIntegerTwoOpaqueKey = 8202');
      expect(smoke).toContain('static xpod_rdf_term_key stored_double_key(double value)');
      expect(smoke).toContain('kDoubleOnePointFiveOpaqueKey = 8211');
      expect(smoke).toContain('kDoubleTwoPointFiveOpaqueKey = 8212');
      expect(smoke).toContain('static xpod_rdf_term_key stored_bool_key(bool value)');
      expect(smoke).toContain('kBoolTrueOpaqueKey = 8221');
      expect(smoke).toContain('kBoolFalseOpaqueKey = 8222');
      expect(smoke).toContain('kTimeLateOpaqueKey = 8000');
      expect(smoke).toContain('kTimeEarlyOpaqueKey = 8100');
      expect(smoke).toContain('kTimeEarlyLexical = "2026-08-28T23:30:00+12:00"');
      expect(smoke).toContain('kTimeLateLexical = "2026-08-28T12:00:00Z"');
      expect(smoke).toContain('bytes_equal(terms[i].value, "urn:num")');
      expect(smoke).toContain('bytes_equal(terms[i].value, "urn:double")');
      expect(smoke).toContain('bytes_equal(terms[i].value, "urn:flag")');
      expect(smoke).toContain('bytes_equal(terms[i].value, "urn:time")');
      expect(smoke).toContain('SELECT ?g ?s ?n WHERE { GRAPH ?g { ?s <urn:num> ?n } } ORDER BY ?s');
      expect(smoke).toContain('GRAPH variable stored numeric missing graph binding');
      expect(smoke).toContain(
        'graph_variable_json.find(kDefaultGraphIri) != std::string_view::npos',
      );
      expect(smoke).toContain(
        'graph_variable_stored_numeric_json.find(kDefaultGraphIri) != std::string_view::npos',
      );
      expect(smoke).toContain('GRAPH variable stored numeric missing integer datatype');
      expect(smoke).toContain('SELECT ?s ?n FROM <urn:g> WHERE { ?s <urn:num> ?n } ORDER BY ?s');
      expect(smoke).toContain('FROM stored numeric did not reach exact graph scope scan');
      expect(smoke).toContain('FROM stored numeric missing integer datatype');
      expect(smoke).toContain('SELECT DISTINCT ?x WHERE { { ?x ?p ?o } UNION { ?s ?p2 ?x } } ORDER BY ?x');
      expect(smoke).toContain('union_profile.find("Union")');
      expect(smoke).toContain('SELECT ?s ?tail WHERE { ?s ?p ?o OPTIONAL { ?o ?p2 ?tail } } ORDER BY ?s LIMIT 1');
      expect(smoke).toContain('optional_profile.find("OptionalJoin")');
      expect(smoke).toContain('optional_profile.find("LimitOffset")');
      expect(smoke).toContain('SELECT ?s WHERE { ?s ?p ?o MINUS { ?s <urn:p2> ?tail } }');
      expect(smoke).toContain('minus_profile.find("Minus")');
      expect(smoke).toContain('SELECT ?s WHERE { VALUES ?s { <urn:s> <urn:o> } ?s ?p ?o } ORDER BY ?s');
      expect(smoke).toContain('values_profile.find("Values") == std::string_view::npos &&');
      expect(smoke).toContain('values_profile.find("HashJoin") == std::string_view::npos');
      expect(smoke).toContain('values_json.find("urn:tail") != std::string_view::npos');
      expect(smoke).toContain('distinct_scan');
      expect(smoke).toContain('SELECT ?p WHERE { <urn:s> ql:has-predicate ?p } ORDER BY ?p');
      expect(smoke).toContain('has-predicate did not use Xpod distinct scan');
      expect(smoke).toContain('has_predicate_profile.find("HasPredicateScan")');
      expect(smoke).toContain('SELECT ?o WHERE { <urn:s> <urn:p>* ?o } ORDER BY ?o');
      expect(smoke).toContain('zero-or-more path missing zero-length urn:s');
      expect(smoke).toContain('zero-or-more path missing transitive urn:o');
      expect(smoke).toContain('SELECT ?s ?o WHERE { ?s ?p ?o FILTER(?o != <urn:tail>) } ORDER BY ?s');
      expect(smoke).toContain('filter_profile.find("Filter")');
      expect(smoke).toContain('filter_json.find("urn:tail") != std::string_view::npos');
      expect(smoke).toContain('SELECT ?s ?o WHERE { ?s ?p ?o FILTER(?o = <urn:o>) } ORDER BY ?s');
      expect(smoke).toContain('equal_filter_profile.find("Filter")');
      expect(smoke).toContain('equal_filter_json.find("urn:tail") != std::string_view::npos');
      expect(smoke).toContain('SELECT ?s WHERE { ?s ?p ?o FILTER(?o = <urn:o>) } ORDER BY ?s');
      expect(smoke).toContain('filtered_projection_profile.find("Filter")');
      expect(smoke).toContain('SELECT ?s ?o WHERE { ?s ?p ?o FILTER(?o = \\"literal-value\\") } ORDER BY ?s');
      expect(smoke).toContain('literal_filter_profile.find("Filter")');
      expect(smoke).toContain('literal_filter_json.find("literal-value")');
      expect(smoke).toContain('SELECT ?s ?o WHERE { ?s ?p ?o FILTER(\\"literal-value\\" = ?o) } ORDER BY ?s');
      expect(smoke).toContain('literal_left_filter_profile.find("Filter")');
      expect(smoke).toContain('literal_left_filter_json.find("literal-value")');
      expect(smoke).toContain('select accept mismatch did not fail');
      expect(smoke).toContain('select_accept_wildcard_request.accept_media_type = bytes("application/*")');
      expect(smoke).toContain('select accept wildcard failed');
      expect(smoke).toContain('select_accept_q0_request.accept_media_type = bytes("application/sparql-results+json; q=0")');
      expect(smoke).toContain('select accept q0 did not fail');
      expect(smoke).toContain('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }');
      expect(smoke).toContain('construct_request.accept_media_type = bytes("application/n-triples")');
      expect(smoke).toContain('construct_accept_list_request.accept_media_type = bytes("text/turtle, application/n-triples; q=0.9")');
      expect(smoke).toContain('construct accept list failed');
      expect(smoke).toContain('construct_accept_q0_list_request.accept_media_type = bytes("application/n-triples; q=0, application/*; q=0.5")');
      expect(smoke).toContain('construct accept q0 list failed');
      expect(smoke).toContain('construct accept mismatch did not fail');
      expect(smoke).toContain('construct missing stored integer triple');
      expect(smoke).toContain('construct missing stored double triple');
      expect(smoke).toContain('construct missing stored bool triple');
      expect(smoke).toContain('CONSTRUCT { <urn:s> <urn:p2> ?o } WHERE { <urn:missing> ?p ?o }');
      expect(smoke).toContain('construct empty graph body mismatch');
      expect(smoke).toContain('construct_empty_profile.find("Construct")');
      expect(smoke).toContain('CONSTRUCT { ?s <urn:p2> <urn:tail> } WHERE { ?s <urn:p> ?o }');
      expect(smoke).toContain('construct constant template missing urn:s tail');
      expect(smoke).toContain('construct constant template missing urn:literal-s tail');
      expect(smoke).toContain('CONSTRUCT { ?s <urn:p2> ?label } WHERE { ?s <urn:p> ?o BIND(STR(?s) AS ?label) }');
      expect(smoke).toContain('construct bind template missing urn:s label');
      expect(smoke).toContain('construct bind template missing urn:literal-s label');
      expect(smoke).toContain('CONSTRUCT { ?s ?p2 ?o } WHERE { ?s <urn:p> ?o BIND(IRI(\\\"urn:p2\\\") AS ?p2) }');
      expect(smoke).toContain('construct iri bind template missing urn:s row');
      expect(smoke).toContain('construct iri bind template missing urn:literal-s row');
      expect(smoke).toContain('CONSTRUCT { ?copy <urn:p2> ?o } WHERE { ?s <urn:p> ?o BIND(IRI(\\\"urn:copy\\\") AS ?copy) }');
      expect(smoke).toContain('construct subject iri bind template missing urn:o row');
      expect(smoke).toContain('construct subject iri bind template missing literal row');
      expect(smoke).toContain('CONSTRUCT { _:copy <urn:p2> ?o } WHERE { ?s <urn:p> ?o }');
      expect(smoke).toContain('construct blank template missing iri object row');
      expect(smoke).toContain('construct blank template missing literal object row');
      expect(smoke).toContain('CONSTRUCT { ?s <urn:p2> ?o } WHERE { GRAPH <urn:g> { ?s <urn:p> ?o } }');
      expect(smoke).toContain('construct graph missing urn:s row');
      expect(smoke).toContain('construct graph leaked graph iri');
      expect(smoke).toContain('CONSTRUCT { ?s <urn:p2> ?o } WHERE { GRAPH ?g { ?s <urn:p> ?o } }');
      expect(smoke).toContain('construct graph variable missing urn:s row');
      expect(smoke).toContain('construct graph variable missing literal row');
      expect(smoke).toContain('construct graph variable leaked graph iri');
      expect(smoke).toContain('DESCRIBE <urn:s>');
      expect(smoke).toContain('DESCRIBE <urn:missing>');
      expect(smoke).toContain('describe missing iri body mismatch');
      expect(smoke).toContain('describe_missing_iri_profile.find("DESCRIBE")');
      expect(smoke).toContain('DESCRIBE ?s WHERE { ?s <urn:p> <urn:o> }');
      expect(smoke).toContain('describe variable missing subject triple');
      expect(smoke).toContain('describe variable leaked other subject');
      expect(smoke).toContain('DESCRIBE * WHERE { ?s <urn:p> <urn:o> }');
      expect(smoke).toContain('describe star missing subject triple');
      expect(smoke).toContain('describe star leaked other subject');
      expect(smoke).toContain('DESCRIBE ?s WHERE { ?s <urn:p> <urn:missing> }');
      expect(smoke).toContain('describe empty variable body mismatch');
      expect(smoke).toContain('DESCRIBE ?s WHERE { ?s <urn:p> ?o }');
      expect(smoke).toContain('describe multi variable missing urn:s triple');
      expect(smoke).toContain('describe multi variable missing urn:literal-s triple');
      expect(smoke).toContain('DESCRIBE ?s ?o WHERE { ?s <urn:p> ?o }');
      expect(smoke).toContain('describe multi resource variable missing urn:o triple');
      expect(smoke).toContain('describe multi resource variable leaked literal as subject');
      expect(smoke).toContain('DESCRIBE <urn:s> <urn:literal-s>');
      expect(smoke).toContain('describe explicit multi missing urn:s triple');
      expect(smoke).toContain('describe explicit multi missing urn:literal-s triple');
      expect(smoke).toContain('describe_explicit_multi_profile.find("DESCRIBE")');
      expect(smoke).toContain('DESCRIBE <urn:s> <urn:missing>');
      expect(smoke).toContain('describe explicit mixed missing urn:s triple');
      expect(smoke).toContain('describe explicit mixed leaked missing iri');
      expect(smoke).toContain('describe missing stored integer triple');
      expect(smoke).toContain('describe missing stored double triple');
      expect(smoke).toContain('describe missing stored bool triple');
      expect(smoke).toContain('CREATE GRAPH <urn:created>');
      expect(smoke).toContain('CREATE no-op update failed');
      expect(smoke).toContain('CREATE no-op update called backend mutation callback');
      expect(smoke).toContain('CREATE no-op update result mismatch');
      expect(smoke).toContain('INSERT DATA { <urn:inserted> <urn:p> <urn:o> }');
      expect(smoke).toContain('apply_mutation');
      expect(smoke).toContain('insert data update failed');
      expect(smoke).toContain('insert data did not call backend mutation callback');
      expect(smoke).toContain('SELECT ?o WHERE { <urn:inserted> <urn:p> ?o }');
      expect(smoke).toContain('insert data verification missing inserted row');
      expect(smoke).toContain('DELETE DATA { <urn:inserted> <urn:p> <urn:o> }');
      expect(smoke).toContain('delete data update failed');
      expect(smoke).toContain('delete data did not call backend mutation callback');
      expect(smoke).toContain('delete data verification still returned deleted row');
      expect(smoke).toContain('INSERT DATA { <urn:inserted-literal> <urn:p> \\"literal-value\\" }');
      expect(smoke).toContain('DELETE DATA { <urn:inserted-literal> <urn:p> \\"literal-value\\" }');
      expect(smoke).toContain('literal insert data did not call backend mutation callback');
      expect(smoke).toContain('literal delete data verification still returned deleted row');
      expect(smoke).toContain('PREFIX ex: <urn:> INSERT DATA { ex:inserted ex:p ex:o }');
      expect(smoke).toContain('prefixed insert data update failed');
      expect(smoke).toContain('prefixed delete data verification still returned deleted row');
      expect(smoke).toContain('INSERT DATA { <urn:inserted> <urn:p> <urn:o> };');
      expect(smoke).toContain('DELETE DATA { <urn:inserted> <urn:p> <urn:o> }');
      expect(smoke).toContain('sequence update failed');
      expect(smoke).toContain('sequence update did not call backend mutation callback');
      expect(smoke).toContain('sequence update verification still returned deleted row');
      expect(smoke).toContain('INSERT DATA { <urn:inserted> <urn:p> <urn:o> . <urn:inserted-literal> <urn:p> \\"literal-value\\" }');
      expect(smoke).toContain('multi triple insert update failed');
      expect(smoke).toContain('multi triple insert did not call backend mutation callback');
      expect(smoke).toContain('multi triple delete verification still returned iri row');
      expect(smoke).toContain('INSERT DATA { GRAPH <urn:g> { <urn:inserted-graph> <urn:p> <urn:o> } }');
      expect(smoke).toContain('named graph insert data update failed');
      expect(smoke).toContain('named graph insert verification missing inserted row');
      expect(smoke).toContain('named graph delete data verification still returned deleted row');
      expect(smoke).toContain('CLEAR GRAPH <urn:clear-g>');
      expect(smoke).toContain('clear graph update failed');
      expect(smoke).toContain('clear graph verification still returned cleared row');
      expect(smoke).toContain('DROP SILENT GRAPH <urn:clear-g>');
      expect(smoke).toContain('drop silent graph update failed');
      expect(smoke).toContain('INSERT { <urn:inserted> <urn:p> ?o } WHERE { <urn:s> <urn:p> ?o }');
      expect(smoke).toContain('variable insert where did not insert WHERE-bound row');
      expect(smoke).toContain('variable insert where verification missing row');
      expect(smoke).toContain('variable insert where cleanup failed');
      expect(smoke).toContain('INSERT { _:whereBlank <urn:p> ?o } WHERE { <urn:s> <urn:p> ?o }');
      expect(smoke).toContain('blank insert where did not insert WHERE-bound blank row');
      expect(smoke).toContain('blank insert where verification missing blank node');
      expect(smoke).toContain('OPTIONAL { ?o <urn:p2> ?tail }');
      expect(smoke).toContain('optional insert where did not insert optional-bound row');
      expect(smoke).toContain('optional insert where cleanup mismatch');
      expect(smoke).toContain('OPTIONAL { ?o <urn:missing-p> ?tail }');
      expect(smoke).toContain('optional missing insert where inserted unbound row');
      expect(smoke).toContain('INSERT DATA { _:link <urn:p> <urn:o> . <urn:blank-object-holder> <urn:p> _:link }');
      expect(smoke).toContain('blank link verification missing blank node');
      expect(smoke).toContain('DELETE { GRAPH <urn:g> { <urn:inserted-graph> <urn:p> ?o } }');
      expect(smoke).toContain('INSERT { GRAPH <urn:g> { <urn:modified-graph> <urn:p> ?o } }');
      expect(smoke).toContain('graph modify update did not move graph row');
      expect(smoke).toContain('graph modify verification mismatch');
      expect(smoke).toContain('WITH <urn:g>');
      expect(smoke).toContain('INSERT { <urn:with-modified-graph> <urn:p> ?o }');
      expect(smoke).toContain('WITH modify update did not move graph row');
      expect(smoke).toContain('WITH modify verification mismatch');
      expect(smoke).toContain('USING <urn:g>');
      expect(smoke).toContain('urn:using-source');
      expect(smoke).toContain('urn:using-noise');
      expect(smoke).toContain('urn:using-modified-graph');
      expect(smoke).toContain('USING modify update did not move graph row');
      expect(smoke).toContain('USING modify verification mismatch');
      expect(smoke).toContain('USING NAMED <urn:g>');
      expect(smoke).toContain('USING NAMED <urn:other-g>');
      expect(smoke).toContain('GRAPH ?g { ?s <urn:using-named-p> ?o }');
      expect(smoke).toContain('urn:using-named-source-g');
      expect(smoke).toContain('urn:using-named-source-other');
      expect(smoke).toContain('urn:using-named-noise');
      expect(smoke).toContain('urn:using-named-modified');
      expect(smoke).toContain('USING NAMED modify update did not move graph rows');
      expect(smoke).toContain('USING NAMED modify g verification mismatch');
      expect(smoke).toContain('USING NAMED modify other graph verification mismatch');
      expect(smoke).toContain('GRAPH <urn:third-g> { <urn:using-named-noise> <urn:using-named-p> ?o }');
      expect(smoke).toContain('urn:using-named-disallowed-modified');
      expect(smoke).toContain('USING NAMED disjoint modify result mismatch');
      expect(smoke).toContain('USING NAMED disjoint modify leaked forbidden mutation');
      expect(smoke).toContain('WHERE { <urn:s> <urn:p> ?o . ?o <urn:p2> ?tail }');
      expect(smoke).toContain('join modify update did not apply delete+insert');
      expect(smoke).toContain('join modify cleanup mismatch');
      expect(smoke).toContain('MINUS { ?o <urn:missing-p> ?tail }');
      expect(smoke).toContain('minus insert where did not insert retained row');
      expect(smoke).toContain('minus insert where cleanup mismatch');
      expect(smoke).toContain('{ <urn:s> <urn:p> ?o } UNION { <urn:missing-s> <urn:p> ?o }');
      expect(smoke).toContain('union insert where did not insert retained row');
      expect(smoke).toContain('union insert where cleanup mismatch');
      expect(smoke).toContain('{ <urn:s> <urn:p> ?o } UNION { <urn:o> <urn:p2> ?tail }');
      expect(smoke).toContain('union branch-local insert where did not skip unbound template row');
      expect(smoke).toContain('union branch-local insert where cleanup mismatch');
      expect(smoke).toContain('FILTER EXISTS { ?o <urn:p2> ?tail }');
      expect(smoke).toContain('exists insert where did not insert retained row');
      expect(smoke).toContain('exists insert where cleanup mismatch');
      expect(smoke).toContain('INSERT { <urn:inserted-literal> <urn:p> ?o }');
      expect(smoke).toContain('FILTER NOT EXISTS { ?o <urn:p2> ?tail }');
      expect(smoke).toContain('not-exists insert where did not insert retained rows');
      expect(smoke).toContain('not-exists insert where cleanup mismatch');
      expect(smoke).toContain('FILTER NOT EXISTS { ?o <urn:missing-p> ?tail }');
      expect(smoke).toContain('not-exists known-empty insert where did not insert retained rows');
      expect(smoke).toContain('not-exists known-empty insert where cleanup mismatch');
      expect(smoke).toContain('FILTER(!EXISTS { ?o <urn:p2> ?tail })');
      expect(smoke).toContain('negated exists insert where did not insert retained rows');
      expect(smoke).toContain('negated exists insert where cleanup mismatch');
      expect(smoke).toContain('FILTER(?o IN (<urn:o>, <urn:tail>))');
      expect(smoke).toContain('in-filter insert where did not insert retained row');
      expect(smoke).toContain('in-filter insert where cleanup mismatch');
      expect(smoke).toContain('FILTER(?o NOT IN (<urn:tail>))');
      expect(smoke).toContain('not-in-filter insert where did not insert retained row');
      expect(smoke).toContain('not-in-filter insert where cleanup mismatch');
      expect(smoke).toContain('DELETE { <urn:s> <urn:p> ?o } INSERT { <urn:modified> <urn:p> ?o } WHERE { <urn:s> <urn:p> ?o }');
      expect(smoke).toContain('modify update did not apply delete+insert');
      expect(smoke).toContain('modify verification mismatch');
      expect(smoke).toContain('ASK { ?s ?p ?o }');
      expect(smoke).toContain('ask_json.find(R"("boolean":true)")');
      expect(smoke).toContain('ask_profile.find("Ask")');
      expect(smoke).toContain('ASK { <urn:missing> ?p ?o }');
      expect(smoke).toContain('ask false boolean mismatch');
      expect(smoke).toContain('SELECT (COUNT(DISTINCT ?s) AS ?count) WHERE { ?s ?p ?o }');
      expect(smoke).toContain('distinct scalar count missing value 7');
      expect(smoke).toContain('SELECT (GROUP_CONCAT(STR(?s); separator=\\",\\") AS ?labels) WHERE { ?s ?p ?o }');
      expect(smoke).toContain('group concat missing label urn:s');
      expect(smoke).toContain('SELECT (SAMPLE(?o) AS ?sample) WHERE { <urn:s> <urn:p> ?o }');
      expect(smoke).toContain('sample aggregate missing urn:o');
      expect(smoke).toContain('SELECT (SUM(?n) AS ?sum) (AVG(?n) AS ?avg) WHERE { ?s ?p ?o BIND(2 AS ?n) }');
      expect(smoke).toContain('numeric aggregate missing sum value 26');
      expect(smoke).toContain('numeric aggregate missing avg value 2');
      expect(smoke).toContain('SELECT (SUM(?n) AS ?sum) (AVG(?n) AS ?avg) WHERE { ?s <urn:num> ?n }');
      expect(smoke).toContain('stored numeric aggregate missing sum value 3');
      expect(smoke).toContain('stored numeric aggregate missing avg value 1.5');
      expect(smoke).toContain('SELECT ?s WHERE { ?s <urn:num> ?n FILTER(?n > 1) } ORDER BY ?s');
      expect(smoke).toContain('stored numeric filter missing urn:literal-s');
      expect(smoke).toContain('stored numeric filter leaked urn:s');
      expect(smoke).toContain('SELECT (SUM(?n) AS ?sum) (AVG(?n) AS ?avg) WHERE { ?s <urn:double> ?n }');
      expect(smoke).toContain('stored double aggregate missing sum value 4');
      expect(smoke).toContain('stored double aggregate missing avg value 2');
      expect(smoke).toContain('SELECT ?s WHERE { ?s <urn:double> ?n FILTER(?n > 2) } ORDER BY ?s');
      expect(smoke).toContain('stored double filter missing urn:literal-s');
      expect(smoke).toContain('stored double filter leaked urn:s');
      expect(smoke).toContain('SELECT ?s WHERE { ?s <urn:double> ?n } ORDER BY DESC(?n) LIMIT 1');
      expect(smoke).toContain('stored double order missing urn:literal-s');
      expect(smoke).toContain('stored double order leaked urn:s');
      expect(smoke).toContain('SELECT ?i ?d WHERE { <urn:s> <urn:num> ?i . <urn:s> <urn:double> ?d }');
      expect(smoke).toContain('stored numeric projection missing integer value 1');
      expect(smoke).toContain('stored numeric projection missing double value 1.5');
      expect(smoke).toContain(
        'stored_numeric_projection_json.find("http://www.w3.org/2001/XMLSchema#int")',
      );
      expect(smoke).toContain(
        'stored_numeric_projection_json.find("http://www.w3.org/2001/XMLSchema#decimal")',
      );
      expect(smoke).toContain('SELECT ?s ?m WHERE { ?s <urn:double> ?n BIND((?n + 1) AS ?m) } ORDER BY ?s');
      expect(smoke).toContain('stored double arithmetic missing value 3.5');
      expect(smoke).toContain('stored double arithmetic missing BIND/OrderBy profile');
      expect(smoke).toContain('SELECT ?flag WHERE { <urn:s> <urn:flag> ?flag }');
      expect(smoke).toContain('stored bool projection missing true value');
      expect(smoke).toContain('SELECT ?s WHERE { ?s <urn:flag> ?flag FILTER(?flag) } ORDER BY ?s');
      expect(smoke).toContain('stored bool filter missing urn:s');
      expect(smoke).toContain('stored bool filter leaked urn:literal-s');
      expect(smoke).toContain('SELECT ?s WHERE { ?s <urn:num> 1 } ORDER BY ?s');
      expect(smoke).toContain('stored int constant missing urn:s');
      expect(smoke).toContain('SELECT ?s WHERE { ?s <urn:double> 2.5 } ORDER BY ?s');
      expect(smoke).toContain('stored double constant missing urn:literal-s');
      expect(smoke).toContain('SELECT ?s WHERE { ?s <urn:flag> true } ORDER BY ?s');
      expect(smoke).toContain('stored bool constant missing urn:s');
      expect(smoke).toContain('SELECT ?s WHERE { VALUES ?n { 1 } ?s <urn:num> ?n } ORDER BY ?s');
      expect(smoke).toContain('stored int VALUES constant missing urn:s');
      expect(smoke).toContain('SELECT ?s WHERE { VALUES ?n { 2.5 } ?s <urn:double> ?n } ORDER BY ?s');
      expect(smoke).toContain('stored double VALUES constant missing urn:literal-s');
      expect(smoke).toContain('SELECT ?s WHERE { VALUES ?flag { true } ?s <urn:flag> ?flag } ORDER BY ?s');
      expect(smoke).toContain('stored bool VALUES constant missing urn:s');
      expect(smoke).toContain('SELECT ?s WHERE { VALUES ?n { 1 2 } ?s <urn:num> ?n } ORDER BY ?s');
      expect(smoke).toContain('stored int multi-row VALUES constant');
      expect(smoke).toContain('SELECT ?s WHERE { VALUES ?n { 1.5 2.5 } ?s <urn:double> ?n } ORDER BY ?s');
      expect(smoke).toContain('stored double multi-row VALUES constant');
      expect(smoke).toContain('SELECT ?s WHERE { VALUES ?flag { true false } ?s <urn:flag> ?flag } ORDER BY ?s');
      expect(smoke).toContain('stored bool multi-row VALUES constant');
      expect(smoke).toContain('SELECT ?s WHERE { VALUES (?s ?n) { (<urn:s> 1) (<urn:literal-s> 2) } ?s <urn:num> ?n } ORDER BY ?s');
      expect(smoke).toContain('stored int multi-column VALUES constant');
      expect(smoke).toContain('SELECT ?s WHERE { VALUES (?s ?flag) { (<urn:s> true) (<urn:literal-s> false) } ?s <urn:flag> ?flag } ORDER BY ?s');
      expect(smoke).toContain('stored bool multi-column VALUES constant');
      expect(smoke).toContain('SELECT ?s WHERE { ?s <urn:num> ?n FILTER(?n = 1) } ORDER BY ?s');
      expect(smoke).toContain('stored int equals filter');
      expect(smoke).toContain('SELECT ?s WHERE { ?s <urn:num> ?n FILTER(?n != 1) } ORDER BY ?s');
      expect(smoke).toContain('stored int not-equals filter');
      expect(smoke).toContain('SELECT ?s WHERE { ?s <urn:double> ?n FILTER(?n = 2.5) } ORDER BY ?s');
      expect(smoke).toContain('stored double equals filter');
      expect(smoke).toContain('SELECT ?s WHERE { ?s <urn:double> ?n FILTER(?n != 2.5) } ORDER BY ?s');
      expect(smoke).toContain('stored double not-equals filter');
      expect(smoke).toContain('SELECT ?s WHERE { ?s <urn:flag> ?flag FILTER(?flag = true) } ORDER BY ?s');
      expect(smoke).toContain('stored bool equals filter');
      expect(smoke).toContain('SELECT ?s WHERE { ?s <urn:flag> ?flag FILTER(?flag != true) } ORDER BY ?s');
      expect(smoke).toContain('stored bool not-equals filter');
      expect(smoke).toContain('SELECT ?s WHERE { ?s <urn:num> ?n FILTER(?n IN (1, 2)) } ORDER BY ?s');
      expect(smoke).toContain('stored int multi-value IN filter');
      expect(smoke).toContain('SELECT ?s WHERE { ?s <urn:num> ?n FILTER(?n NOT IN (1, 2)) } ORDER BY ?s');
      expect(smoke).toContain('stored int multi-value NOT IN filter');
      expect(smoke).toContain('SELECT ?s WHERE { ?s <urn:double> ?n FILTER(?n IN (1.5, 2.5)) } ORDER BY ?s');
      expect(smoke).toContain('stored double multi-value IN filter');
      expect(smoke).toContain('SELECT ?s WHERE { ?s <urn:double> ?n FILTER(?n NOT IN (1.5, 2.5)) } ORDER BY ?s');
      expect(smoke).toContain('stored double multi-value NOT IN filter');
      expect(smoke).toContain('SELECT ?s WHERE { ?s <urn:flag> ?flag FILTER(?flag IN (true, false)) } ORDER BY ?s');
      expect(smoke).toContain('stored bool multi-value IN filter');
      expect(smoke).toContain('SELECT ?s WHERE { ?s <urn:flag> ?flag FILTER(?flag NOT IN (true, false)) } ORDER BY ?s');
      expect(smoke).toContain('stored bool multi-value NOT IN filter');
      expect(smoke).toContain('SELECT ?s WHERE { ?s <urn:num> ?n FILTER(?n IN (1)) } ORDER BY ?s');
      expect(smoke).toContain('stored int IN filter');
      expect(smoke).toContain('SELECT ?s WHERE { ?s <urn:num> ?n FILTER(?n NOT IN (1)) } ORDER BY ?s');
      expect(smoke).toContain('stored int NOT IN filter');
      expect(smoke).toContain('SELECT ?s WHERE { ?s <urn:double> ?n FILTER(?n IN (2.5)) } ORDER BY ?s');
      expect(smoke).toContain('stored double IN filter');
      expect(smoke).toContain('SELECT ?s WHERE { ?s <urn:double> ?n FILTER(?n NOT IN (2.5)) } ORDER BY ?s');
      expect(smoke).toContain('stored double NOT IN filter');
      expect(smoke).toContain('SELECT ?s WHERE { ?s <urn:flag> ?flag FILTER(?flag IN (true)) } ORDER BY ?s');
      expect(smoke).toContain('stored bool IN filter');
      expect(smoke).toContain('SELECT ?s WHERE { ?s <urn:flag> ?flag FILTER(?flag NOT IN (true)) } ORDER BY ?s');
      expect(smoke).toContain('stored bool NOT IN filter');
      expect(smoke).toContain('state.time_rows_enabled = true');
      expect(smoke).toContain('SELECT ?s ?time WHERE { ?s <urn:time> ?time } ORDER BY ?time');
      expect(smoke).toContain('stored dateTime order mismatch');
      expect(smoke).toContain('early_pos < late_pos');
      expect(smoke).toContain('join missing urn:s json=%.*s profile=%.*s scans=%d estimates=%d');
      expect(smoke).toContain('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }');
      expect(smoke).toContain('construct_result.result_media_type');
      expect(smoke).toContain('application/n-triples');
      expect(smoke).toContain('<urn:s> <urn:p> <urn:o> .');
      expect(smoke).toContain('DESCRIBE <urn:s>');
      expect(smoke).toContain('describe_result.result_media_type');
      expect(smoke).toContain('<urn:s> <urn:p> <urn:o> .');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails clearly when the upstream source tree is not supplied', () => {
    let output = '';
    const env = cleanQleverEnv();
    try {
      execFileSync('node', [scriptPath, '--dry-run'], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe', env });
    } catch (error) {
      const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
      output = [failure.stdout, failure.stderr, failure.message]
        .filter(Boolean)
        .map((value) => Buffer.isBuffer(value) ? value.toString('utf8') : String(value))
        .join('\n');
    }
    expect(output).toContain('missing --qlever-source or XPOD_QLEVER_SOURCE_DIR');
  });

  it('preserves the child exit status when a linked runtime assertion fails', () => {
    const script = readFileSync(scriptPath, 'utf8');

    expect(script).toContain("'status' in error ? error.status : undefined");
    expect(script).toContain("'signal' in error ? error.signal : undefined");
    expect(script).toContain('child status=${String(status)} signal=${String(signal)}');
  });
});
