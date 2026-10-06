import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '../..');
const selectorPath = path.join(repoRoot, 'scripts/select-desktop-update-baseline.cjs');
const { selectBaselineTag } = require(selectorPath);

function runCli(candidate: string, releases: unknown): { status: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'xpod-baseline-'));
  try {
    const releasesPath = path.join(dir, 'releases.json');
    writeFileSync(releasesPath, JSON.stringify(releases));
    try {
      const stdout = execFileSync(
        process.execPath,
        [selectorPath, '--candidate', candidate, '--releases', releasesPath],
        { encoding: 'utf8' },
      );
      return { status: 0, stdout, stderr: '' };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { status: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('desktop self-update baseline selection', () => {
  it('takes the newest stable release strictly older than the candidate', () => {
    // The real RC shape: a newer stable was published mid-flight, so blindly
    // taking the newest release would ask the released app to downgrade.
    const releases = [
      { tagName: 'v0.4.29' },
      { tagName: 'v0.4.25' },
      { tagName: 'v0.4.20' },
      { tagName: 'v0.4.19' },
    ];
    expect(selectBaselineTag(releases, '0.4.26-rc.277')).toBe('v0.4.25');
    expect(selectBaselineTag(releases, '0.4.26')).toBe('v0.4.25');
  });

  it('never uses a pre-release tag as the released baseline', () => {
    const releases = [{ tagName: 'v0.4.26-rc.9' }, { tagName: 'v0.4.25' }];
    expect(selectBaselineTag(releases, '0.4.26-rc.277')).toBe('v0.4.25');
  });

  it('rejects an equal or newer release as the baseline', () => {
    expect(selectBaselineTag([{ tagName: 'v0.4.26' }], '0.4.26')).toBeUndefined();
    expect(selectBaselineTag([{ tagName: 'v0.4.27' }, { tagName: 'v0.4.29' }], '0.4.26')).toBeUndefined();
    // A candidate that is itself a pre-release ranks below its own stable version.
    expect(selectBaselineTag([{ tagName: 'v0.4.26' }], '0.4.26-rc.277')).toBeUndefined();
  });

  it('ignores malformed rows and non-version tags', () => {
    const releases = [null, {}, { tagName: 'latest' }, { tagName: 'v0.4.24' }, { tag: 'v0.4.23' }];
    expect(selectBaselineTag(releases, '0.4.26')).toBe('v0.4.24');
  });

  it('fails loudly when the released train has no older baseline', () => {
    const result = runCli('0.4.26-rc.277', [{ tagName: 'v0.4.29' }]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('::error::no stable desktop release older than 0.4.26-rc.277');
  });

  it('prints the chosen tag for the workflow to download', () => {
    const result = runCli('0.4.26-rc.277', [{ tagName: 'v0.4.29' }, { tagName: 'v0.4.25' }]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('v0.4.25');
  });

  it('rejects a candidate that is not a version', () => {
    expect(() => selectBaselineTag([{ tagName: 'v0.4.25' }], 'release/0.4.26')).toThrow(/semantic version/);
  });
});
