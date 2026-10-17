import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function parseWorkflow(text: string): any {
  const parsed = spawnSync('bun', ['-e', 'console.log(JSON.stringify(Bun.YAML.parse(await Bun.stdin.text())));'], { input: text, encoding: 'utf8' });
  expect(parsed.status).toBe(0);
  return JSON.parse(parsed.stdout);
}
import { MODULE_TARGETS, modulePackageName } from '../../packages/xpod-cli/src/module-catalog';
import { productTarget, productTargets } from '../../scripts/module-product-targets';

test('one canonical target catalog projects matching packages and native CI hosts', () => {
  for (const module of ['api', 'css']) {
    const rows = productTargets(module);
    expect(rows.map(row => row.target)).toEqual(MODULE_TARGETS.map(row => `${row.platform}-${row.arch}`));
    for (const row of rows) {
      expect(row.name).toBe(modulePackageName(module, row.platform, row.arch));
      expect(productTarget(module, row.target, row)).toEqual(row);
      expect(() => productTarget(module, row.target, { platform: 'wrong', arch: row.arch })).toThrow('host/target mismatch');
      expect(() => productTarget(module, row.target, { platform: row.platform, arch: 'wrong' })).toThrow('host/target mismatch');
    }
  }
  expect(productTargets('api').map(row => row.runner)).toEqual(['macos-15', 'macos-15-intel', 'ubuntu-24.04-arm', 'ubuntu-24.04']);
  expect(() => productTargets('unknown')).toThrow('Unsupported product module');
  expect(() => productTarget('api', '../../linux-x64')).toThrow('Unsupported product target');
  expect(() => productTarget('api', 'win32-x64')).toThrow('Unsupported product target');
});

test('native source declarations cannot imply products or consumer/release acceptance', () => {
  expect(productTargets('api').every(row => row.nativeSourceAvailable)).toBe(true);
  const css = productTargets('css');
  expect(css.filter(row => row.nativeSourceAvailable).map(row => row.target)).toEqual(['darwin-arm64']);
  expect(css.filter(row => !row.nativeSourceAvailable)).toHaveLength(3);
  for (const row of css.filter(row => !row.nativeSourceAvailable)) {
    expect(row.status).toBe('pending-native-source');
    expect(row.reason).toContain('no product archive');
  }
  expect(css.every(row => !('releaseQualified' in row) && !('consumerValidated' in row))).toBe(true);
});

test('both workflows consume actual helper projections and keep target-specific artifacts', () => {
  for (const module of ['api', 'css']) {
    const text = readFileSync(new URL(`../../.github/workflows/${module}-module-product.yml`, import.meta.url), 'utf8');
    const yaml = parseWorkflow(text);
    expect(yaml.jobs.products.strategy.matrix).toBe('${{ fromJSON(needs.contract.outputs.matrix) }}');
    expect(yaml.jobs.products.strategy['max-parallel']).toBe(1);
    expect(yaml.jobs.products['runs-on']).toBe('${{ matrix.runner }}');
    expect(text).toContain(`bun scripts/module-product-targets.ts ${module}`);
    expect(text).toContain('--target "${{ matrix.target }}"');
    expect(text).toContain(`${module}-module-products-\${{ matrix.target }}-`);
    expect(yaml.permissions).toEqual({ contents: 'read' });
  }
  const css = parseWorkflow(readFileSync(new URL('../../.github/workflows/css-module-product.yml', import.meta.url), 'utf8'));
  const pending = css.jobs['pending-native-sources'];
  expect(pending.strategy.matrix).toBe('${{ fromJSON(needs.contract.outputs.pending) }}');
  expect(JSON.stringify(pending)).not.toContain('product.tgz');
  expect(JSON.stringify(pending)).not.toContain('css-module-producer.py');
});

test('CLI helper refuses a forged local host before any producer side effects', () => {
  const target = MODULE_TARGETS.find(row => row.platform !== process.platform || row.arch !== process.arch)!;
  const result = spawnSync('bun', ['scripts/module-product-targets.ts', 'api', `${target.platform}-${target.arch}`, '--require-host'], { encoding: 'utf8' });
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('host/target mismatch');
});
