import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), 'utf8');
}

describe('signaling-driven pod verifier asset', () => {
  it('calls xpod signaling routes before validating a Pod resource', async () => {
    const html = await readRepoFile('static/app/signal-pod.html');

    expect(html).toContain('Xpod Signal Pod Verifier');
    expect(html).toContain('/v1/signal/nodes/');
    expect(html).toContain('/routes');
    expect(html).toContain('/sessions');
    expect(html).toContain("kind: 'p2p'");
    expect(html).not.toContain('/p2p-sessions');
    expect(html).not.toContain('/relay-sessions');
    expect(html).toContain('nodeCandidates');
    expect(html).toContain('fetch(signalUrl.href');
    expect(html).toContain('fetch(resourceUrl.href');
    expect(html).not.toContain('/v1/relay/');
  });

  it('keeps the source copy under ui/public so build:ui preserves the verifier', async () => {
    const sourceHtml = await readRepoFile('ui/public/signal-pod.html');
    const generatedHtml = await readRepoFile('static/app/signal-pod.html');

    expect(generatedHtml).toBe(sourceHtml);
  });
});
