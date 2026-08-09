import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const packageNames = [
  'ai-connections',
  'extension-sdk',
  'shared-ui',
  'solid-sdk',
];

const dependencyNames = [
  '@undefineds.co/ai-connections',
  '@undefineds.co/extension-sdk',
  '@undefineds.co/shared-ui',
  '@undefineds.co/solid-sdk',
];

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8'));
}

test('Xpod owns editable applet package sources in its workspace', async() => {
  const rootManifest = await readJson('../../package.json');

  assert.ok(rootManifest.workspaces?.includes('packages/*'));

  for (const packageName of packageNames) {
    await stat(new URL(`../../packages/${packageName}/src`, import.meta.url));
    await stat(new URL(`../../packages/${packageName}/test`, import.meta.url));
  }
});

test('the Xpod UI resolves applet packages from the workspace', async() => {
  const uiManifest = await readJson('../../ui/package.json');

  for (const dependencyName of dependencyNames) {
    assert.equal(uiManifest.dependencies[dependencyName], 'workspace:*');
  }

  assert.equal(JSON.stringify(uiManifest).includes('vendor/@undefineds.co'), false);
});
