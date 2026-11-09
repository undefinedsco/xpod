import { expect, test } from 'bun:test';
import { MODULE_CATALOG, MODULE_TARGETS, modulePackageName, moduleTarget } from '../src/module-catalog';

test('every declared module and target resolves one canonical package', () => {
  const names = new Set<string>();
  for (const module of MODULE_CATALOG) {
    for (const target of MODULE_TARGETS) {
      expect(moduleTarget(target.platform, target.arch)).toBe(target);
      const name = modulePackageName(module.id, target.platform, target.arch);
      expect(name).toBe(`${module.packagePrefix}-${target.platform}-${target.arch}`);
      names.add(name!);
      for (const alias of module.commands) expect(modulePackageName(alias, target.platform, target.arch)).toBe(name);
    }
  }
  expect(names.size).toBe(MODULE_CATALOG.length * MODULE_TARGETS.length);
});

test('unsupported identities never produce installable package names', () => {
  for (const [platform, arch] of [['win32', 'x64'], ['linux', 'ia32'], ['darwin', '../arm64'], ['', 'arm64']]) {
    expect(moduleTarget(platform, arch)).toBeUndefined();
    expect(modulePackageName('afs', platform, arch)).toBeUndefined();
  }
  expect(modulePackageName('unknown', 'linux', 'x64')).toBeUndefined();
});
