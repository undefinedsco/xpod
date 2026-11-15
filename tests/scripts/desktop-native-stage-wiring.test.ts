/** The desktop RC/stable stage must hand the release gate a REAL measured native
 * platform budget. The gate uploads `desktop/runtime-pack{,-budget}.json`, and the
 * immediately-following step requires the packaged `runtime/qlever` payload. Both
 * only exist if staging itself produces the accepted native platform package via
 * the one shared publication producer. This pins that wiring so the gate can never
 * again upload paths that nothing produces.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const stageSource = readFileSync(path.join(repoRoot, 'desktop/scripts/stage-runtime.ts'), 'utf8');
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'desktop/package.json'), 'utf8'));
const candidate = readFileSync(path.join(repoRoot, '.github/workflows/candidate.yml'), 'utf8');
const release = readFileSync(path.join(repoRoot, '.github/workflows/release-desktop.yml'), 'utf8');

describe('desktop native platform staging wiring', () => {
  test('staging consumes the shared publication producer instead of a second measurement', () => {
    expect(stageSource).toContain("require('../../scripts/build-platform-package.cjs')");
    expect(stageSource).toContain("buildPlatformPackage('current'");
    // No private second measurement: the budget module is never imported here and
    // staging never shells out to a pack of its own. (Comments may name the shared
    // producer's checks; only real code would import or invoke them.)
    expect(stageSource).not.toMatch(/require\([^)]*platform-package-budget/);
    expect(stageSource).not.toMatch(/\bverifyPlatformPackageBudget\s*\(/);
    expect(stageSource).not.toMatch(/['"]npm['"]\s*,\s*\[?\s*['"]pack/);
  });

  test('the producer stages into its own scratch directory, never the promoted runtime', () => {
    // The producer removes and rebuilds its stage directory.
    expect(stageSource).toContain("path.join(temporary, 'native-platform')");
    expect(stageSource).toContain("const install = path.join(temporary, 'runtime')");
  });

  test('measured evidence is published only after a successful promotion', () => {
    const sync = stageSource.slice(stageSource.indexOf('promoteDesktopRuntime(install, destination)'));
    // Publication follows promotion in source order, and the pending files are
    // removed in the finally block so a failure leaves no success budget behind.
    expect(sync).toContain('renameSync(pending.pack, packReport)');
    expect(sync).toContain('renameSync(pending.budget, budgetReport)');
    expect(stageSource).toContain('for (const file of [pending.pack, pending.budget]) rmSync(file, { force: true });');
  });

  test('the CLI entry is still required, so the native fold cannot replace the public runtime', () => {
    expect(stageSource).toContain("if (!existsSync(cli)) throw new Error('Installed CLI entry is missing');");
  });

  test('both desktop dist callers keep the gate paths the producer now actually writes', () => {
    for (const workflow of [candidate, release]) {
      expect(workflow).toContain('runtime/qlever/bin/xpod_qlever_local_runtime');
      expect(workflow).toContain('runtime/qlever/manifest.json');
    }
    // dist -> build:runtime -> the stage script that now produces the evidence.
    expect(packageJson.scripts.dist).toContain('build:runtime');
    expect(packageJson.scripts['build:runtime']).toContain('stage-runtime.ts');
    expect(candidate).toContain('desktop/runtime-pack-budget.json');
    expect(candidate).toContain('desktop/runtime-pack.json');
  });
});
