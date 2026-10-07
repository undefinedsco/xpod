import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { verifyPackagedSourceCheckout } from '../../scripts/helpers/packaged-desktop-source';
const execute = promisify(execFile);

it('rejects draft source while allowing only the existing candidate version transformation and generated outputs', async () => {
  const parent = path.join(process.cwd(), '.test-data', 'packaged-desktop-source');
  await mkdir(parent, { recursive: true });
  const cwd = await mkdtemp(path.join(parent, 'source-'));
  const git = (...args: string[]) => execute('git', args, { cwd });
  const root = { name: '@undefineds.co/xpod', version: '0.4.26', optionalDependencies: { '@undefineds.co/xpod-darwin-arm64': '0.4.26' } };
  try {
    await mkdir(path.join(cwd, 'desktop')); await mkdir(path.join(cwd, 'src'));
    await mkdir(path.join(cwd, 'static/landing'), { recursive: true });
    await writeFile(path.join(cwd, 'static/landing/index.html'), '<p>source input</p>');
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify(root));
    await writeFile(path.join(cwd, 'desktop/package.json'), JSON.stringify({ name: 'xpod-desktop', version: root.version }));
    await writeFile(path.join(cwd, 'src/handler.ts'), 'export const original = true;\n');
    await git('init', '-q'); await git('add', 'package.json', 'desktop/package.json', 'src/handler.ts', 'static/landing/index.html');
    await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Freeze fixture');
    const sha = (await git('rev-parse', 'HEAD')).stdout.trim();
    await expect(verifyPackagedSourceCheckout({ cwd, sourceSha: sha, version: root.version })).resolves.toBeUndefined();
    const version = '0.4.26-rc.12';
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ ...root, version, optionalDependencies: { '@undefineds.co/xpod-darwin-arm64': version } }));
    await writeFile(path.join(cwd, 'desktop/package.json'), JSON.stringify({ name: 'xpod-desktop', version }));
    await mkdir(path.join(cwd, 'static/app')); await writeFile(path.join(cwd, 'static/app/generated.js'), 'generated');
    await writeFile(path.join(cwd, 'desktop/runtime-pack.json'), '[]');
    await writeFile(path.join(cwd, 'desktop/runtime-pack-budget.json'), '{}');
    await expect(verifyPackagedSourceCheckout({ cwd, sourceSha: sha, version })).resolves.toBeUndefined();
    await writeFile(path.join(cwd, 'src/handler.ts'), 'export const changed = true;\n');
    await expect(verifyPackagedSourceCheckout({ cwd, sourceSha: sha, version })).rejects.toThrow('Uncommitted source');
    await git('restore', 'src/handler.ts');
    await writeFile(path.join(cwd, 'src/rogue.ts'), 'export const rogue = true;\n');
    await expect(verifyPackagedSourceCheckout({ cwd, sourceSha: sha, version })).rejects.toThrow('Uncommitted source');
    await rm(path.join(cwd, 'src/rogue.ts'));
    await writeFile(path.join(cwd, 'desktop/runtime-source.ts'), 'export const rogue = true;\n');
    await expect(verifyPackagedSourceCheckout({ cwd, sourceSha: sha, version })).rejects.toThrow('Uncommitted source');
    await rm(path.join(cwd, 'desktop/runtime-source.ts'));
    await writeFile(path.join(cwd, 'static/landing/index.html'), '<p>different source input</p>');
    await expect(verifyPackagedSourceCheckout({ cwd, sourceSha: sha, version })).rejects.toThrow('Uncommitted source');
    await git('restore', 'static/landing/index.html');
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ ...root, version, scripts: { start: 'foreign' } }));
    await expect(verifyPackagedSourceCheckout({ cwd, sourceSha: sha, version })).rejects.toThrow('version transformation');
    await expect(verifyPackagedSourceCheckout({ cwd, sourceSha: '0'.repeat(40), version })).rejects.toThrow('artifact source');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
