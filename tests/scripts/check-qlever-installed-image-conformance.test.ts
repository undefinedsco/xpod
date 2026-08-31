import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts/check-qlever-installed-image-conformance.ts');
const installedRunnerPath = path.join(repoRoot, 'src/acceptance/run-installed-qlever-conformance.ts');

describe('check-qlever-installed-image-conformance', () => {
  it('requires immutable SQLite and PG image refs and rejects fallback logs', () => {
    expect(existsSync(scriptPath)).toBe(true);
    const script = readFileSync(scriptPath, 'utf8');

    expect(script).toContain('XPOD_INSTALLED_IMAGE_REF');
    expect(script).toContain('XPOD_PG17_QLEVER_IMAGE_REF');
    expect(script).toContain('@sha256:[a-f0-9]{64}');
    expect(script).toContain('inspect installed Xpod image');
    expect(script).toContain('inspect PG17 QLever image');
    expect(script).toContain("['image', 'inspect', args.installedImage]");
    expect(script).toContain("['image', 'inspect', args.pgImage]");
    expect(script).toContain('^[A-Za-z0-9._:/-]+@sha256:');
    expect(script).toContain('FORBIDDEN_PRODUCT_LOG');
  });

  it('runs the compiled product seam in the installed Xpod image for SQLite and PG', () => {
    const script = readFileSync(scriptPath, 'utf8');

    expect(script).toContain('XPOD_QLEVER_SEMANTIC_FIXTURE_PATH');
    expect(script).toContain('dist/acceptance/run-installed-qlever-conformance.js');
    expect(script).toContain("runInstalledProduct(args, network, 'sqlite'");
    expect(script).toContain("runInstalledProduct(args, network, 'pg'");
    expect(script).toContain("'--name', container");
    expect(script).toContain("['rm', '-f', sqliteContainer]");
    expect(script).toContain("['rm', '-f', cloudContainer]");
    expect(script).toContain('timeout: DOCKER_PROBE_TIMEOUT_MS');
    expect(script).toContain('assertSemanticConformanceParity');
    expect(script).toContain('Local/Cloud native search mismatch');
    expect(existsSync(installedRunnerPath)).toBe(true);
    const runner = readFileSync(installedRunnerPath, 'utf8');
    expect(runner).toContain('runLocalQleverSemanticConformance');
    expect(runner).toContain('runPostgresQleverSemanticConformance');
    expect(runner).toContain('runNativeSearchFusionAcceptance');
    expect(runner).toContain('createLocalNativeSearchEngine');
    expect(runner).toContain('runPostgresNativeSearchFusionAcceptance');
  });
});
