import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File, sha256Hex, type XpodCliManifest } from '../src/manifest';
import type { ApplicationSourceKit } from '../src/application-sources';
import { CLIUI_MODIFICATION_NOTICE, GOOGLE_WIN_MINMAX_BSD_NOTICE } from '../src/promotion';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

test('portable package preserves the original project notice in install and application source material', () => {
  const parent = path.join(repo, '.test-data/xpod-cli/project-notice');
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(path.join(parent, 'package-'));
  try {
    const target = `${process.platform}-${process.arch}`;
    const built = spawnSync(process.execPath, [path.join(repo, 'packages/xpod-cli/scripts/build.ts'), '--cli-only', '--target', target, '--out', work], {
      cwd: '/tmp', encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
    });
    if (built.status !== 0) throw new Error(`Portable package failed: ${built.stderr}`);
    expect(built.status).toBe(0);
    const install = path.join(work, target, 'install');
    const relative = 'licenses/xpod/LICENSE';
    const original = path.join(repo, 'LICENSE');
    expect(readFileSync(path.join(install, relative))).toEqual(readFileSync(original));
    const manifest: XpodCliManifest = JSON.parse(readFileSync(path.join(install, 'manifest.json'), 'utf8'));
    expect(manifest.artifacts.find((artifact) => artifact.name === 'xpod-license')).toMatchObject({
      kind: 'notice', path: relative, included: true, sha256: sha256File(original), license: { spdx: 'MIT', status: 'verified' },
    });
    const kit: ApplicationSourceKit = JSON.parse(readFileSync(path.join(install, 'sources/application-source.json'), 'utf8'));
    expect(kit.files.find((file) => file.path === relative)?.sha256).toBe(sha256File(original));
    expect(readFileSync(path.join(work, target, 'application-source', relative))).toEqual(readFileSync(original));
    const noticeText = readFileSync(path.join(install, 'NOTICES.md'), 'utf8');
    expect(noticeText).toContain(CLIUI_MODIFICATION_NOTICE);
    expect(kit.files.find((file) => file.path === 'NOTICES.md')?.sha256).toBe(sha256File(path.join(install, 'NOTICES.md')));
    expect(readFileSync(path.join(work, target, 'application-source/NOTICES.md'), 'utf8')).toBe(noticeText);
    const notices = JSON.parse(readFileSync(path.join(install, 'licenses/javascript/index.json'), 'utf8'));
    expect(notices.generated.bunVersion).toBe(process.versions.bun);
    const prefixNotice = notices.generated.files.find((file: { sha256: string }) => file.sha256 === notices.generated.prefixSha256);
    expect(readFileSync(path.join(install, 'lib/xpodcli.mjs')).subarray(0, notices.generated.prefixBytes)).toEqual(readFileSync(path.join(install, 'licenses/javascript', prefixNotice.object)));
    for (const file of notices.generated.files) {
      expect(sha256File(path.join(install, 'licenses/javascript', file.object))).toBe(file.sha256);
      expect(kit.files.find((item) => item.path === `licenses/javascript/${file.object}`)?.sha256).toBe(file.sha256);
    }
    const cliui = notices.packages.find((entry: { name: string }) => entry.name === 'cliui');
    expect(cliui.declaredLicense).toBe('ISC');
    const fileNotices = cliui.files.filter((file: { provenance?: { fileDeclaredLicense?: string } }) => file.provenance?.fileDeclaredLicense === 'Artistic-2.0');
    expect(fileNotices).toHaveLength(2);
    for (const file of fileNotices) {
      expect(sha256File(path.join(install, 'licenses/javascript', file.object))).toBe(file.sha256);
      expect(kit.files.find((item) => item.path === `licenses/javascript/${file.object}`)?.sha256).toBe(file.sha256);
    }
    expect(readFileSync(path.join(install, 'licenses/javascript', fileNotices[0].object), 'utf8')).toContain('Copyright (c) npm, Inc. and Contributors');
    expect(readFileSync(path.join(install, 'licenses/javascript', fileNotices[1].object), 'utf8')).toContain('The Artistic License 2.0');
  } finally { rmSync(work, { recursive: true, force: true }); }
}, 90_000);

test('Google supplemental notice preserves the audited original header bytes', () => {
  expect(sha256Hex(GOOGLE_WIN_MINMAX_BSD_NOTICE)).toBe('4bb1a993a4e9853fe5692573812e24b469a7ec5e2af13116c8baf99716fda44a');
  expect(GOOGLE_WIN_MINMAX_BSD_NOTICE).not.toContain('\\n');
});
