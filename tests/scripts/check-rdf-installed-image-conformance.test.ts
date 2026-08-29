import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts/check-rdf-installed-image-conformance.ts');
const installedRunnerPath = path.join(repoRoot, 'src/acceptance/run-installed-rdf-conformance.ts');

describe('check-rdf-installed-image-conformance', () => {
  it('requires immutable public Local and PG image refs and rejects fallback logs', () => {
    expect(existsSync(scriptPath)).toBe(true);
    const script = readFileSync(scriptPath, 'utf8');

    expect(script).toContain('XPOD_INSTALLED_IMAGE_REF');
    expect(script).toContain('XPOD_PG17_PUBLIC_IMAGE_REF');
    expect(script).toContain('@sha256:[a-f0-9]{64}');
    expect(script).toContain('inspect installed Xpod image');
    expect(script).toContain('inspect public PG17 image');
    expect(script).toContain("['image', 'inspect', args.installedImage]");
    expect(script).toContain("['image', 'inspect', args.pgImage]");
    expect(script).toContain('FORBIDDEN_PRODUCT_LOG');
    expect(script).toContain('^[A-Za-z0-9._:/-]+@sha256:');
    expect(script).not.toContain('XPOD_PG17_QLEVER_IMAGE_REF');
    expect(script).not.toContain('native_sparql_capabilities');
  });

  it('runs the compiled product seam for SQLite and public PG without PG QLever', () => {
    const script = readFileSync(scriptPath, 'utf8');

    expect(script).toContain('XPOD_QLEVER_SEMANTIC_FIXTURE_PATH');
    expect(script).toContain('dist/acceptance/run-installed-rdf-conformance.js');
    expect(script).toContain("runInstalledProduct(args, network, 'sqlite'");
    expect(script).toContain("runInstalledProduct(args, network, 'pg-public'");
    expect(script).toContain("'--name', container");
    expect(script).toContain("['rm', '-f', sqliteContainer]");
    expect(script).toContain("['rm', '-f', publicCloudContainer]");
    expect(script).toContain('timeout: DOCKER_PROBE_TIMEOUT_MS');
    expect(script).toContain('assertSemanticConformanceParity');
    expect(script).toContain('Local/public Cloud search mismatch');
    expect(existsSync(installedRunnerPath)).toBe(true);
    const runner = readFileSync(installedRunnerPath, 'utf8');
    expect(runner).toContain('runLocalQleverSemanticConformance');
    expect(runner).toContain('runPostgresPublicSemanticConformance');
    expect(runner).toContain("from './PublicCloudSemanticConformance'");
    expect(runner).toContain('runNativeSearchFusionAcceptance');
    expect(runner).toContain('createLocalNativeSearchEngine');
    expect(runner).toContain('runPostgresPublicSearchFusionAcceptance');
    expect(runner).not.toContain('runPostgresQleverSemanticConformance');
    expect(runner).not.toContain('runPostgresNativeSearchFusionAcceptance');
  });
});
