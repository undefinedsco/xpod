import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectJavascriptNotices } from '../src/javascript-notices';

// Each product selects one reviewed prefix; another valid product is still refused.
test('preview and AFS commands bind distinct exact reviewed generated prefixes', () => {
  const parent = path.resolve(import.meta.dir, '../../../.test-data/generated-product-profiles');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'case-'));
  try {
    const generated = path.resolve(import.meta.dir, '../licenses/javascript/generated/1.4.2');
    const stage = path.join(root, 'stage');
    mkdirSync(stage); mkdirSync(path.join(root, 'node_modules'));
    writeFileSync(path.join(stage, 'main.ts'), 'export const value=1;');
    const metafile = path.join(root, 'inputs.json');
    writeFileSync(metafile, JSON.stringify({ inputs: { 'main.ts': { bytes: 21, imports: [] } },
      outputs: { 'payload.mjs': { inputs: { 'main.ts': { bytesInOutput: 21 } } } } }));
    const cli = path.join(root, 'payload.mjs');
    const profiles = ['preview', 'afs-commands'] as const;
    for (const emitted of profiles) {
      const profile = JSON.parse(readFileSync(path.join(generated, emitted + '.json'), 'utf8'));
      const prefix = readFileSync(path.join(generated, profile.file.object));
      expect(prefix.length).toBe(emitted === 'preview' ? 755 : 1867);
      writeFileSync(cli, Buffer.concat([prefix, Buffer.from('\n// main.ts\nexport const value=1;')]));
      for (const selected of profiles) {
        const destination = path.join(root, emitted + '-' + selected);
        const options = { metafile, stageRoot: stage, repoRoot: root, destination,
          target: 'darwin-arm64', cli, bunVersion: '1.4.2', generated, generatedProfile: selected };
        if (selected === emitted) {
          collectJavascriptNotices(options);
          const notice = JSON.parse(readFileSync(path.join(destination, 'index.json'), 'utf8'));
          expect(notice.generated.prefixSha256).toBe(profile.prefixSha256);
        } else {
          expect(() => collectJavascriptNotices(options)).toThrow('prefix differs');
          expect(existsSync(destination)).toBe(false);
        }
      }
      writeFileSync(cli, Buffer.concat([Buffer.from('!'), prefix.subarray(1), Buffer.from('\n// main.ts\n')]));
      const destination = path.join(root, emitted + '-tamper');
      expect(() => collectJavascriptNotices({ metafile, stageRoot: stage, repoRoot: root, destination,
        target: 'darwin-arm64', cli, bunVersion: '1.4.2', generated, generatedProfile: emitted })).toThrow('prefix differs');
      expect(existsSync(destination)).toBe(false);
    }
    const destination = path.join(root, 'unknown');
    expect(() => collectJavascriptNotices({ metafile, stageRoot: stage, repoRoot: root, destination,
      target: 'darwin-arm64', cli, bunVersion: '1.4.2', generated,
      generatedProfile: '../index' as 'preview' })).toThrow('Unsupported generated JavaScript profile');
    expect(existsSync(destination)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
