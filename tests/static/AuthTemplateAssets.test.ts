import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), 'utf8');
}

describe('static auth templates', () => {
  it.each([
    'static/app/auth.html',
    'static/dashboard/auth.html',
    'static/landing/index.html',
  ])('uses the app build stylesheet for %s', async (templatePath) => {
    const html = await readRepoFile(templatePath);

    expect(html).toContain('/app/assets/main.css');
    expect(html).not.toContain('/app/assets/index.css');
  });
});
