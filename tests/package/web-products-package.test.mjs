import assert from 'node:assert/strict';
import { stat, readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);

test('the published package includes the API-served callback product', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));

  assert.ok(manifest.files?.includes('static'));
  await stat(new URL('static/auth-callback/auth-callback.html', root));
  await stat(new URL('static/auth-callback/assets', root));
});
