import { readFile, stat } from 'node:fs/promises';
import { expect, test } from 'vitest';

const packageNames = [
  'ai-connections',
  'extension-sdk',
  'shared-ui',
  'solid-sdk',
];

const registryDependencyNames = [
  '@undefineds.co/extension-sdk',
  '@undefineds.co/shared-ui',
  '@undefineds.co/solid-sdk',
];

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8'));
}

test('Xpod owns editable applet package sources in its workspace', async() => {
  const rootManifest = await readJson('../../package.json');

  expect(rootManifest.workspaces).toContain('packages/*');

  for (const packageName of packageNames) {
    await stat(new URL(`../../packages/${packageName}/src`, import.meta.url));
    await stat(new URL(`../../packages/${packageName}/test`, import.meta.url));
  }
});

test('the Xpod UI resolves the editable AI connections applet from the workspace', async() => {
  const uiManifest = await readJson('../../ui/package.json');

  expect(uiManifest.dependencies['@undefineds.co/ai-connections']).toBe('workspace:*');
  for (const dependencyName of registryDependencyNames) {
    expect(uiManifest.dependencies[dependencyName]).toMatch(/^\^0\.1\.0$/);
  }

  expect(JSON.stringify(uiManifest)).not.toContain('vendor/@undefineds.co');
});
