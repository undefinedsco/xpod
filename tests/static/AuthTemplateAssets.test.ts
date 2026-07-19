import { readFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), 'utf8');
}

async function repoFileExists(relativePath: string): Promise<boolean> {
  try {
    await access(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
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

  it.each([
    'static/app/auth.html',
    'static/dashboard/auth.html',
    'static/landing/index.html',
  ])('references existing static app assets for %s', async (templatePath) => {
    const html = await readRepoFile(templatePath);
    const assetPaths = Array.from(html.matchAll(/\/app\/assets\/[^"']+/g), ([match]) => match);

    expect(assetPaths).toContain('/app/assets/main.css');
    expect(assetPaths.length).toBeGreaterThan(0);

    for (const assetPath of assetPaths) {
      expect(await repoFileExists(`static${assetPath}`)).toBe(true);
    }
  });
});
