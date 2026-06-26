import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), 'utf8');
}

function extractAppStylesheetHrefs(html: string): string[] {
  return [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["'](\/app\/assets\/[^"']+\.css)["'][^>]*>/g)]
    .map((match) => match[1]);
}

describe('static auth templates', () => {
  it.each([
    'static/app/auth.html',
    'static/dashboard/auth.html',
    'static/landing/index.html',
  ])('references CSS assets that exist for %s', async (templatePath) => {
    const html = await readRepoFile(templatePath);
    const stylesheetHrefs = extractAppStylesheetHrefs(html);

    expect(stylesheetHrefs).not.toEqual([]);

    for (const href of stylesheetHrefs) {
      await expect(access(path.join(root, 'static/app', href.slice('/app/'.length)))).resolves.toBeUndefined();
    }
  });
});
