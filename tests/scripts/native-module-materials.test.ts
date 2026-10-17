import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inspectModuleNativeMaterials } from '../../scripts/lib/independent-admission/native-module-materials';

describe('module native original correspondence', () => {
  it('binds actual Inngest bytes while retaining origin and executed ABI gaps', () => {
    const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const files = new Map<string, Buffer>();
    const put = (name: string, value: unknown) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)); files.set(name, bytes); return sha(bytes); };
    const root = 'provenance/native/inngest/';
    const binary = put('node_modules/inngest-cli/bin/inngest', Buffer.from('physical binary'));
    const license = put('node_modules/inngest-cli/bin/LICENSE.md', Buffer.from('license'));
    const archive = put(root + 'release.tar.gz', Buffer.from('archive'));
    const source = put(root + 'source.tar.gz', Buffer.from('source'));
    const commit = 'a'.repeat(40), asset = { name: 'inngest-darwin-arm64.tar.gz', id: 1, size: 7, digest: 'sha256:' + archive };
    const url = 'https://github.com/inngest/inngest/releases/download/v1.0.0/' + asset.name;
    const pins = { version: '1.0.0', repository: 'inngest/inngest', releaseID: 2, sourceCommit: commit, sourceArchive: { sha256: source, bytes: 6 }, assets: { 'darwin-arm64': asset } };
    put('node_modules/inngest-cli/package.json', { name: 'inngest-cli', version: '1.0.0' });
    put(root + 'index.json', { package: 'inngest-cli', version: '1.0.0', platform: 'darwin', arch: 'arm64', sourceCommit: commit, sourceArchiveSHA256: source, officialArchiveSHA256: archive, releaseURL: url, sourceURL: 'https://api.github.com/repos/inngest/inngest/tarball/' + commit, binarySHA256: binary, licenseSHA256: license });
    put(root + 'release.json', { id: 2, tag_name: 'v1.0.0', draft: false, prerelease: false, assets: [{ ...asset, browser_download_url: url }] });
    put(root + 'tag.json', { ref: 'refs/tags/v1.0.0', object: { type: 'commit', sha: commit } });
    const input = () => ({ module: 'api' as const, target: 'darwin-arm64', sourcePins: Buffer.from(JSON.stringify(pins)), members: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes), mode: 0o644 })), readMember: (name: string) => files.get(name)! });
    const result = inspectModuleNativeMaterials(input());
    expect(result.binary.sha256).toBe(binary);
    expect(result.pending).toContain('inngest-executed-runtime-ABI-originals-unavailable');
    expect(result.pending).toContain('inngest-official-release-origin-capability-unavailable');
    files.set('node_modules/inngest-cli/bin/inngest', Buffer.from('different binary'));
    expect(() => inspectModuleNativeMaterials(input())).toThrow('actual Inngest binary');
  });
});
