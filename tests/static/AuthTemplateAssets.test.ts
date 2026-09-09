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

  it.each([
    'ui/public/auth.html',
    'static/app/auth.html',
    'static/dashboard/auth.html',
  ])('follows the global system theme for %s', async (templatePath) => {
    const html = await readRepoFile(templatePath);

    expect(html).toContain('<script src="/app/theme-init.js"></script>');
    expect(html).toContain('bg-background text-foreground');
    expect(html).not.toMatch(/<html[^>]*class="dark"/u);
    expect(html).not.toContain('bg-zinc-950');
  });
});
