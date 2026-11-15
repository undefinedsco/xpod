import { expect, test } from 'bun:test';
import { collectApiModuleAdmissionArtifact } from '../../scripts/lib/independent-admission/artifact-collector';
import { verifyModuleProductInventory } from '../../scripts/lib/independent-admission/module-product-inventory';
import { MODULE_TARGETS, modulePackageName } from '../../packages/xpod-cli/src/module-catalog';

test('serialized platform origins cannot create module custody or disk snapshots', async () => {
  await expect(collectApiModuleAdmissionArtifact({ githubOrigin: { workflowPath: '.github/workflows/api-module-product.yml',
    target: 'linux-x64', sourceSha: 'a'.repeat(40) }, acquisitionRoot: '/does-not-exist',
    projectionOutput: '/does-not-exist' })).rejects.toThrow('controlled module platform origin');
});

test('one physical inventory contract binds each canonical platform and rejects drift', () => {
  const entry = { path: 'dist/main.js', bytes: 2, sha256: 'a'.repeat(64), mode: 0o755 };
  const members = [{ path: 'package.json', bytes: 20, sha256: 'b'.repeat(64), mode: 0o644 }, entry];
  for (const target of MODULE_TARGETS) {
    const manifest = { name: modulePackageName('api', target.platform, target.arch), version: '0.1.0-preview.1',
      xpodModule: { id: 'api', schemaVersion: 1, cliApiVersion: 1, ...target, entry: entry.path,
        files: [{ path: entry.path, size: entry.bytes, mode: entry.mode, sha256: entry.sha256 }] } };
    const input = { module: 'api' as const, target: `${target.platform}-${target.arch}`, version: manifest.version, manifest, members };
    expect(() => verifyModuleProductInventory(input)).not.toThrow();
    for (const change of [{ name: 'wrong' }, { version: '0.0.0' },
      { xpodModule: { ...manifest.xpodModule, cliApiVersion: 2 } },
      { xpodModule: { ...manifest.xpodModule, files: [{ ...manifest.xpodModule.files[0], sha256: 'c'.repeat(64) }] } },
      { xpodModule: { ...manifest.xpodModule, entry: 'missing.js' } }]) {
      expect(() => verifyModuleProductInventory({ ...input, manifest: { ...manifest, ...change } })).toThrow('binding mismatch');
    }
    expect(() => verifyModuleProductInventory({ ...input, members: [...members, entry] })).toThrow();
  }
});
