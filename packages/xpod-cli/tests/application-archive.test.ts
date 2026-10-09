import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyApplicationSourceArchive, type ApplicationSourceKit } from '../src/application-sources';
import { MANIFEST_SCHEMA_VERSION, XPOD_CLI_PACKAGE, XPOD_CLI_VERSION, sha256File, type XpodCliManifest } from '../src/manifest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

test('verifies archive bodies and rejects missing sources/notices, duplicates, links and changed bytes', () => {
  const parent = path.join(repo, '.test-data/xpod-cli-application-archive');
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(path.join(parent, 'archive-'));
  const root = path.join(work, 'application-source');
  const contents = {
    'packages/xpod-cli/src/entry.ts': 'console.log("fixture");',
    'packages/xpod-cli/scripts/rebuild-application.ts': '// recipe fixture',
    'licenses/NOTICE': 'Original license notice\r\n',
  };
  const tar = (args: string[]): void => {
    const result = spawnSync('tar', args, { cwd: work, encoding: 'utf8' });
    if (result.status !== 0) { throw new Error(result.stderr); }
  };
  try {
    for (const [relative, text] of Object.entries(contents)) {
      const filename = path.join(root, relative);
      mkdirSync(path.dirname(filename), { recursive: true }); writeFileSync(filename, text);
    }
    const files = Object.keys(contents).map((relative) => ({ path: relative, sha256: sha256File(path.join(root, relative)), sizeBytes: statSync(path.join(root, relative)).size }));
    const kit: ApplicationSourceKit = {
      schemaVersion: 2, distribution: 'external-runtime', status: 'application-materials', scope: 'Test fixture application only',
      target: `${process.platform}-${process.arch}`, cliSha256: 'a'.repeat(64),
      source: { commit: 'b'.repeat(40), dirtyTreeHash: null },
      compiler: { version: 'fixture', executableSha256: 'c'.repeat(64), hostTarget: `${process.platform}-${process.arch}` },
      recipe: { entry: files[0].path, workingDirectory: '.', defines: [], removedEnvironmentOptions: ['NODE_ENV', 'NODE_OPTIONS', 'BUN_OPTIONS'], usesInvokedBundler: true },
      inputs: [{ path: files[0].path, sha256: files[0].sha256 }], externalImports: [], files,
    };
    const index = Buffer.from(JSON.stringify(kit));
    writeFileSync(path.join(root, 'source-kit.json'), index);
    const archive = path.join(work, 'material.tar');
    const pack = (): void => tar(['-cf', archive, 'application-source']);
    pack();
    expect(verifyApplicationSourceArchive(archive, index).files).toEqual(files);
    for (const relative of [files[0].path, 'licenses/NOTICE']) {
      rmSync(path.join(root, relative)); pack();
      expect(() => verifyApplicationSourceArchive(archive, index)).toThrow('material missing');
      writeFileSync(path.join(root, relative), contents[relative as keyof typeof contents]);
    }
    pack(); tar(['-rf', archive, 'application-source/source-kit.json']);
    expect(() => verifyApplicationSourceArchive(archive, index)).toThrow('duplicate');
    const entry = path.join(root, files[0].path);
    rmSync(entry); symlinkSync(path.relative(path.dirname(entry), path.join(root, 'licenses/NOTICE')), entry); pack();
    expect(() => verifyApplicationSourceArchive(archive, index)).toThrow('Unsafe');
    rmSync(entry); linkSync(path.join(root, 'licenses/NOTICE'), entry); pack();
    expect(() => verifyApplicationSourceArchive(archive, index)).toThrow('Unsafe');
    rmSync(entry); writeFileSync(entry, 'Changed after index generation'); pack();
    expect(() => verifyApplicationSourceArchive(archive, index)).toThrow('drift');
    writeFileSync(entry, contents[files[0].path as keyof typeof contents]);
    writeFileSync(path.join(root, 'source-kit.json'), JSON.stringify({ ...kit, scope: 'Different archived index' })); pack();
    expect(() => verifyApplicationSourceArchive(archive, index)).toThrow('index mismatch');
    writeFileSync(path.join(root, 'source-kit.json'), index);

    // Refresh the outer archive receipt after removing a notice. A valid
    // manifest/archive hash must not hide missing corresponding material.
    const install = path.join(work, 'install'); mkdirSync(path.join(install, 'sources'), { recursive: true });
    writeFileSync(path.join(install, 'sources/application-source.json'), index);
    const installedArchive = path.join(install, 'sources/application-source.tar.gz');
    const manifest: XpodCliManifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION, distribution: 'external-runtime', package: XPOD_CLI_PACKAGE, version: XPOD_CLI_VERSION,
      platform: kit.target, channel: 'local-preview', sourceSHA: kit.source.commit, dirtyTreeHash: null,
      source: { mode: 'local-preview', commit: kit.source.commit, dirty: false },
      selectedEnginePin: { engine: 'agentfs', repository: 'https://github.com/tursodatabase/agentfs', commit: 'd'.repeat(40), sdkLicenseStatus: 'verified', cliLicenseStatus: 'pending', rootLicensePresent: false },
      artifacts: [], validationState: 'unverified', generatedAt: new Date().toISOString(), notes: [],
    };
    const verify = (): { ok: boolean; detail: string } => {
      tar(['-czf', installedArchive, 'application-source']);
      manifest.artifacts = [
        { name: 'xpodcli', kind: 'cli', path: 'lib/xpodcli.mjs', included: true, sha256: kit.cliSha256, sizeBytes: 1, license: { spdx: null, status: 'pending', source: 'fixture' } },
        { name: 'xpodcli-launcher', kind: 'cli', path: 'bin/xpodcli', included: true, sha256: 'f'.repeat(64), sizeBytes: 1, license: { spdx: 'MIT', status: 'pending', source: 'fixture' } },
        ...['json', 'tar.gz'].map((extension) => {
          const relative = `sources/application-source.${extension}`;
          return { name: `application-source.${extension}`, kind: 'source' as const, path: relative, included: true,
            sha256: sha256File(path.join(install, relative)), sizeBytes: statSync(path.join(install, relative)).size,
            license: { spdx: null, status: 'pending' as const, source: 'fixture' } };
        }),
      ];
      writeFileSync(path.join(install, 'manifest.json'), JSON.stringify(manifest));
      const result = spawnSync(process.execPath, [path.join(repo, 'packages/xpod-cli/scripts/verify-install.ts'), '--dir', install, '--skip-exec'], { encoding: 'utf8', timeout: 10_000 });
      const report = JSON.parse(result.stdout) as { checks: { name: string; ok: boolean; detail: string }[] };
      const check = report.checks.find((value) => value.name === 'application source kit binding');
      expect(report.checks.filter((value) => value.name.startsWith('artifact sha256:')).every((value) => value.ok)).toBe(true);
      return { ok: check?.ok ?? false, detail: check?.detail ?? '' };
    };
    expect(verify().ok).toBe(true);
    rmSync(path.join(root, 'licenses/NOTICE'));
    expect(verify().detail).toContain('material missing');
    writeFileSync(path.join(root, 'licenses/NOTICE'), contents['licenses/NOTICE']);
    kit.cliSha256 = 'e'.repeat(64);
    // Keep archive/index internally consistent but bind them to the wrong CLI.
    writeFileSync(path.join(root, 'source-kit.json'), JSON.stringify(kit));
    writeFileSync(path.join(install, 'sources/application-source.json'), JSON.stringify(kit));
    kit.cliSha256 = 'a'.repeat(64);
    expect(verify().detail).toContain('differs from CLI/source identity');
  } finally { rmSync(work, { recursive: true, force: true }); }
});
