import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), 'utf8');
}

describe('browser reachability verifier asset', () => {
  it('is available from the generated /app/ static assets and uses same-origin resource fetches', async () => {
    const html = await readRepoFile('static/app/reachability.html');

    expect(html).toContain('Xpod Reachability Verifier');
    expect(html).toContain('id="resourcePath"');
    expect(html).toContain('/alice/a.txt');
    expect(html).toContain('fetch(targetUrl.href');
    expect(html).toContain('window.location.origin');
    expect(html).not.toContain('/v1/relay/');
  });

  it('keeps the source copy under ui/public so build:ui preserves the verifier', async () => {
    const sourceHtml = await readRepoFile('ui/public/reachability.html');
    const generatedHtml = await readRepoFile('static/app/reachability.html');
    const manifest = await readRepoFile('ui/public/reachability.webmanifest');

    expect(generatedHtml).toBe(sourceHtml);
    expect(manifest).toContain('Xpod Reachability');
    expect(manifest).toContain('/app/reachability.html');
  });
});
