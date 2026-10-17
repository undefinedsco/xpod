import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inspectBunExecutableZip } from '../../scripts/lib/independent-admission/legal-bun-runtime';
import { bunHelperOriginalView } from '../../scripts/lib/independent-admission/legal-bun-helpers';
const archives = [
  'UEsDBBQAAAAIACCqUV2nfsXZHwAAAB0AAAARAAAAYnVuLWxpbnV4LXg2NC9idW4rSy3KTMtMLdLNL89LTVHIzEstKlFIy6woKS1K5QIAUEsBAhQDFAAAAAgAIKpRXad+xdkfAAAAHQAAABEAAAAAAAAAAAAAAIABAAAAAGJ1bi1saW51eC14NjQvYnVuUEsFBgAAAAABAAEAPwAAAE4AAAAAAA==',
  'UEsDBBQAAAAIACCqUV2nfsXZHwAAAB0AAAAGAAAALi4vYnVuK0stykzLTC3SzS/PS01RyMxLLSpRSMusKCktSuUCAFBLAQIUAxQAAAAIACCqUV2nfsXZHwAAAB0AAAAGAAAAAAAAAAAAAACAAQAAAAAuLi9idW5QSwUGAAAAAAEAAQA0AAAAQwAAAAAA',
  'UEsDBBQAAAAIACCqUV2nfsXZHwAAAB0AAAATAAAAYnVuLWxpbnV4LXg2NC9vdGhlcitLLcpMy0wt0s0vz0tNUcjMSy0qUUjLrCgpLUrlAgBQSwECFAMUAAAACAAgqlFdp37F2R8AAAAdAAAAEwAAAAAAAAAAAAAAgAEAAAAAYnVuLWxpbnV4LXg2NC9vdGhlclBLBQYAAAAAAQABAEEAAABQAAAAAAA=',
];
test('ZIP parser streams the exact inert executable, refuses traversal/extra inventory, and confers no issuer', async () => {
  await mkdir('.test-data/legal-bun-runtime-tests', { recursive: true });
  const root = await mkdtemp('.test-data/legal-bun-runtime-tests/tiny-');
  try {
    for (let i = 0; i < archives.length; i++) await writeFile(root + '/' + i + '.zip', Buffer.from(archives[i]!, 'base64'));
    const digest = await inspectBunExecutableZip(root + '/0.zip', 'bun-linux-x64', AbortSignal.timeout(1000));
    expect(digest).toBe(createHash('sha256').update('verifier-owned inert fixture\n').digest('hex'));
    expect(bunHelperOriginalView({ sha256: digest })).toBeUndefined();
    await expect(inspectBunExecutableZip(root + '/1.zip', 'bun-linux-x64', AbortSignal.timeout(1000))).rejects.toThrow();
    await expect(inspectBunExecutableZip(root + '/2.zip', 'bun-linux-x64', AbortSignal.timeout(1000))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
