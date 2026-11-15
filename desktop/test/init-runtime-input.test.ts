import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { initializeRuntimeInput, readReviewedPin } from '../scripts/init-runtime-input';
import { stageBundledBun } from '../scripts/bun-runtime-material';
import { fixtureZip, hash } from './bun-runtime-fixture';

const repoRoot = path.resolve(import.meta.dir, '../..');
const fixtureArchive = () => fixtureZip();
const archiveSha = () => hash(fixtureArchive());
const fixtureExecutableSha = () => hash(Buffer.from('not an executable; selection fixture only'));
const fixtureSourceArchive = () => Buffer.from('fixture full pinned source archive\n');
// The two URLs declared by the fixture pin and material manifest.
const OFFICIAL_ARCHIVE_URL = 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-darwin-aarch64.zip';
const SOURCE_ARCHIVE_URL = 'https://github.com/oven-sh/bun/archive/744846f8.tar.gz';

function scratch(): string {
  const base = path.resolve(import.meta.dir, '../../.test-data/runtime-input-init');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(path.join(base, 'case-'));
}

/**
 * Output nested one level under the case so the producer's cache root — derived
 * from the output's parent — lands inside THIS case. Every test therefore starts
 * cold and stays private; no case can warm another's cache.
 */
function scratchOutput(caseRoot: string, name = 'input'): string {
  return path.join(caseRoot, 'work', name);
}

/**
 * Deterministic offline transport for the fixture identity. It serves exactly
 * the fixture source archive and the fixture official ZIP, and throws on any
 * other URL so an accidental real network call can never look like a pass.
 */
function fixtureFetch(options: { official?: Buffer; source?: Buffer } = {}): typeof fetch {
  const official = options.official ?? fixtureArchive();
  const source = options.source ?? fixtureSourceArchive();
  return (async (url: string) => {
    if (url === SOURCE_ARCHIVE_URL) return new Response(source, { status: 200 });
    if (url === OFFICIAL_ARCHIVE_URL) return new Response(official, { status: 200 });
    throw new Error(`unexpected network request: ${url}`);
  }) as unknown as typeof fetch;
}

/**
 * Mirror the REAL pin layout in a temp root so the initializer can be driven
 * without the multi-MB official archive. The derived identity is still the
 * production one (same constants), only the archive bytes are a fixture.
 */
function pinnedRoot(mutable: { archiveSha?: string; assessmentStatus?: string; reviewer?: string | null } = {}): string {
  const base = path.resolve(import.meta.dir, '../../.test-data/runtime-input-init');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'pin-'));
  const dir = path.join(root, 'packages/xpod-cli/licenses/javascript/generated/1.4.2');
  mkdirSync(path.join(dir, 'objects'), { recursive: true });
  const license = Buffer.from('fixture bun root license\n');
  const runtime = Buffer.from('fixture runtime.js\n');
  const parseTask = Buffer.from('fixture ParseTask.rs\n');
  const object = (name: string, bytes: Buffer) => {
    writeFileSync(path.join(dir, 'objects', `${name}.txt`), bytes);
    return `objects/${name}.txt`;
  };
  writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
    schemaVersion: 1,
    bunVersion: '1.4.2',
    provenance: {
      bunCommit: '744846f844374847c902b5e7fd59b4342a51ef99',
      revision: '1.4.2+744846f84',
      tag: 'bun-v1.4.2',
      releaseUrl: 'https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2',
      compiler: {
        platform: 'darwin-arm64',
        // Must match the fixture archive's real member so admission can verify it.
        executableSha256: fixtureExecutableSha(),
        officialArchiveUrl: OFFICIAL_ARCHIVE_URL,
        // Tests may swap this so a wrong archive is genuinely refused.
        officialArchiveSha256: mutable.archiveSha ?? archiveSha(),
      },
    },
    files: [
      { sourcePath: 'LICENSE.md', object: object('license', license), sha256: hash(license),
        provenance: { sourceUrl: 'https://raw.githubusercontent.com/oven-sh/bun/744846f8/LICENSE.md' } },
      { sourcePath: 'src/runtime.js', object: object('runtime', runtime), sha256: hash(runtime),
        provenance: { sourceUrl: 'https://raw.githubusercontent.com/oven-sh/bun/744846f8/src/runtime.js' } },
      { sourcePath: 'src/bundler/ParseTask.rs', object: object('parse', parseTask), sha256: hash(parseTask),
        provenance: { sourceUrl: 'https://raw.githubusercontent.com/oven-sh/bun/744846f8/src/bundler/ParseTask.rs' } },
    ],
  }));
  // The reviewed material policy the initializer consumes, with the same shape
  // as the checked-in manifest but fixture-sized originals.
  const materialDir = path.join(root, 'desktop/runtime-materials');
  mkdirSync(path.join(materialDir, 'originals'), { recursive: true });
  const put = (name: string, bytes: Buffer) => {
    writeFileSync(path.join(materialDir, 'originals', name), bytes);
    return { path: `originals/${name}`, sha256: hash(bytes) };
  };
  const lic = put('LICENSE.md', license);
  const buildEntry = put('build-entry.ts', runtime);
  const webkitVersion = put('webkit-version.ts', parseTask);
  const webkitSync = put('sync-webkit-source.ts', Buffer.from('fixture sync\n'));
  const assessmentBytes = Buffer.from(JSON.stringify({
    status: mutable.assessmentStatus ?? 'verified',
    reviewer: mutable.reviewer ?? 'fixture reviewer',
    applicableRequirements: ['license', 'source', 'relink'],
    findings: ['fixture'], scopeLimits: ['fixture scope'],
  }, null, 2) + '\n');
  const assessment = put('assessment.json', assessmentBytes);
  const B = 'https://raw.githubusercontent.com/oven-sh/bun/744846f8/fixture';
  writeFileSync(path.join(materialDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, bunVersion: '1.4.2', target: 'darwin-arm64',
    sourceCommit: '744846f844374847c902b5e7fd59b4342a51ef99',
    executableSha256: fixtureExecutableSha(),
    fullSourceArchive: { name: 'bun-source.tar.gz',
      sourceUrl: SOURCE_ARCHIVE_URL,
      sha256: hash(fixtureSourceArchive()), kind: 'source' },
    files: [
      { id: 'license', ...lic, sourceUrl: B + '/LICENSE.md', kind: 'license' },
      { id: 'build-entry', ...buildEntry, sourceUrl: B + '/scripts/build.ts', kind: 'source' },
      { id: 'webkit-version', ...webkitVersion, sourceUrl: B + '/scripts/build/deps/webkit.ts', kind: 'relink' },
      { id: 'webkit-sync', ...webkitSync, sourceUrl: B + '/scripts/sync-webkit-source.ts', kind: 'relink' },
      { id: 'assessment', ...assessment, sourceUrl: 'https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2', kind: 'assessment' },
    ],
  }, null, 2));
  return root;
}


test('derives descriptor and authority from the reviewed manifest, never from the caller', async () => {
  const root = pinnedRoot();
  const caseRoot = scratch();
  const out = scratchOutput(caseRoot);
  const archive = path.join(root, 'bun-darwin-aarch64.zip');
  writeFileSync(archive, fixtureArchive());
  try {
    const result = await initializeRuntimeInput({ repoRoot: root, archive, output: out, fetchImpl: fixtureFetch() });
    const descriptor = JSON.parse(readFileSync(result.descriptor, 'utf8'));
    const authority = JSON.parse(readFileSync(result.authority, 'utf8'));

    // Identity comes from the pin, never the caller.
    expect(descriptor.target).toBe('darwin-arm64');
    expect(authority.sourceCommit).toBe('744846f844374847c902b5e7fd59b4342a51ef99');
    expect(authority.version).toBe('1.4.2');
    expect(descriptor.authoritySha256).toBe(hash(readFileSync(result.authority)));

    // Declared set covers license, source (incl. the full archive), relink, assessment.
    const kinds = authority.files.map((file: { kind: string }) => file.kind);
    for (const required of ['license', 'source', 'relink', 'assessment']) expect(kinds).toContain(required);
    expect(authority.files.some((f: { path: string }) => f.path.endsWith('.tar.gz'))).toBe(true);
    for (const file of authority.files) {
      expect(file.sourceUrl).toMatch(/^https:\/\//u);
      expect(file.sha256).toBe(hash(readFileSync(path.join(out, file.path))));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(caseRoot, { recursive: true, force: true });
  }
});

test('refuses an archive that is not the reviewed official asset', async () => {
  const root = pinnedRoot({ archiveSha: archiveSha() });
  const caseRoot = scratch();
  const out = scratchOutput(caseRoot);
  const archive = path.join(root, 'bun-darwin-aarch64.zip');
  writeFileSync(archive, Buffer.from('not the official asset'));
  try {
    await expect(initializeRuntimeInput({ repoRoot: root, archive, output: out, fetchImpl: fixtureFetch() }))
      .rejects.toThrow('not the reviewed official Bun 1.4.2 asset');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(caseRoot, { recursive: true, force: true }); }
});

test('refuses a drifted pin instead of inventing an identity', () => {
  const root = pinnedRoot();
  const dir = path.join(root, 'packages/xpod-cli/licenses/javascript/generated/1.4.2');
  const index = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
  index.provenance.compiler.platform = 'linux-x64';
  writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
  const archive = path.join(root, 'bun-darwin-aarch64.zip');
  writeFileSync(archive, fixtureArchive());
  try {
    expect(() => readReviewedPin(root)).toThrow('provenance pin is not the reviewed identity');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('re-initializing the same identity is idempotent and reproducible', async () => {
  const root = pinnedRoot();
  const caseRoot = scratch();
  const out = scratchOutput(caseRoot);
  const archive = path.join(root, 'bun-darwin-aarch64.zip');
  writeFileSync(archive, fixtureArchive());
  try {
    const first = await initializeRuntimeInput({ repoRoot: root, archive, output: out, fetchImpl: fixtureFetch() });
    const second = await initializeRuntimeInput({ repoRoot: root, archive, output: out, fetchImpl: fixtureFetch() });
    expect(second.inputHash).toBe(first.inputHash);
    expect(readFileSync(second.descriptor, 'utf8')).toBe(readFileSync(first.descriptor, 'utf8'));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(caseRoot, { recursive: true, force: true }); }
});

test('a failed download or invalid input never damages an existing good descriptor', async () => {
  const root = pinnedRoot();
  const caseRoot = scratch();
  const out = scratchOutput(caseRoot);
  const archive = path.join(root, 'bun-darwin-aarch64.zip');
  writeFileSync(archive, fixtureArchive());
  try {
    const good = await initializeRuntimeInput({ repoRoot: root, archive, output: out, fetchImpl: fixtureFetch() });
    const before = readFileSync(good.descriptor, 'utf8');
    // Drop the verified cache so these cases really exercise the download path.
    const cached = path.join(out, 'bun-darwin-aarch64.zip');
    // A transport failure surfaces as an error and leaves the promoted tree intact.
    const transportFailure = (async (url: string) => {
      if (url === SOURCE_ARCHIVE_URL) return new Response(fixtureSourceArchive(), { status: 200 });
      if (url === OFFICIAL_ARCHIVE_URL) return new Response('', { status: 502 });
      throw new Error(`unexpected network request: ${url}`);
    }) as unknown as typeof fetch;
    rmSync(cached, { force: true });
    await expect(initializeRuntimeInput({ repoRoot: root, output: out, fetchImpl: transportFailure }))
      .rejects.toThrow('HTTP 502');
    expect(readFileSync(good.descriptor, 'utf8')).toBe(before);
    // A digest-mismatched download is also refused without touching the tree.
    const wrongDigest = (async (url: string) => {
      if (url === SOURCE_ARCHIVE_URL) return new Response(fixtureSourceArchive(), { status: 200 });
      if (url === OFFICIAL_ARCHIVE_URL) return new Response(Buffer.from('not the asset'), { status: 200 });
      throw new Error(`unexpected network request: ${url}`);
    }) as unknown as typeof fetch;
    rmSync(cached, { force: true });
    await expect(initializeRuntimeInput({ repoRoot: root, output: out, fetchImpl: wrongDigest }))
      .rejects.toThrow('does not match the reviewed digest');
    expect(readFileSync(good.descriptor, 'utf8')).toBe(before);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(caseRoot, { recursive: true, force: true }); }
});

test('downloads from the pin URL when no archive is supplied, and caches by digest', async () => {
  const root = pinnedRoot();
  const caseRoot = scratch();
  const out = scratchOutput(caseRoot);
  let calls = 0; let seen = '';
  const fetchImpl = (async (url: string) => {
    if (url === SOURCE_ARCHIVE_URL) return new Response(fixtureSourceArchive(), { status: 200 });
    if (url !== OFFICIAL_ARCHIVE_URL) throw new Error(`unexpected network request: ${url}`);
    calls++; seen = url;
    return new Response(fixtureArchive(), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const first = await initializeRuntimeInput({ repoRoot: root, output: out, fetchImpl });
    expect(first.archiveSource).toBe('pin-download');
    // The URL came from the pin, never from the caller.
    expect(seen).toBe('https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-darwin-aarch64.zip');
    expect(calls).toBe(1);
    // Second run reuses the verified cache; no additional network call.
    const second = await initializeRuntimeInput({ repoRoot: root, output: out, fetchImpl });
    expect(second.archiveSource).toBe('cache');
    expect(calls).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(caseRoot, { recursive: true, force: true }); }
});

test('an unreviewed assessment can only produce controlled-preview, never release', async () => {
  const root = pinnedRoot({ assessmentStatus: 'pending', reviewer: null });
  const caseRoot = scratch();
  const out = scratchOutput(caseRoot);
  const archive = path.join(root, 'bun-darwin-aarch64.zip');
  writeFileSync(archive, fixtureArchive());
  try {
    // Default with a pending assessment is preview, never a silent release.
    const pending = await initializeRuntimeInput({ repoRoot: root, archive, output: out, fetchImpl: fixtureFetch() });
    expect(JSON.parse(readFileSync(pending.descriptor, 'utf8')).mode).toBe('controlled-preview');
    // Explicitly asking for release with unreviewed material is refused.
    await expect(initializeRuntimeInput({ repoRoot: root, archive, output: out, mode: 'release', fetchImpl: fixtureFetch() }))
      .rejects.toThrow('reviewed verified material assessment');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(caseRoot, { recursive: true, force: true }); }
});

test('a verified reviewed assessment yields the release descriptor stable packaging needs', async () => {
  const root = pinnedRoot();
  const caseRoot = scratch();
  const out = scratchOutput(caseRoot);
  const archive = path.join(root, 'bun-darwin-aarch64.zip');
  writeFileSync(archive, fixtureArchive());
  try {
    const result = await initializeRuntimeInput({ repoRoot: root, archive, output: out, fetchImpl: fixtureFetch() });
    const descriptor = JSON.parse(readFileSync(result.descriptor, 'utf8'));
    expect(descriptor.mode).toBe('release');
    const authority = JSON.parse(readFileSync(result.authority, 'utf8'));
    expect(authority.assessment.status).toBe('verified');
    // The FULL pinned source archive is declared, not just the build entry.
    expect(authority.files.filter((f: { kind: string }) => f.kind === 'source').length).toBeGreaterThanOrEqual(2);
    // And the existing release gate accepts it.
    const staged = scratchOutput(caseRoot, 'staged');
    stageBundledBun(root, staged, result.descriptor);
    const receipt = JSON.parse(readFileSync(path.join(staged, 'licenses/bun/receipt.json'), 'utf8'));
    expect(receipt.mode).toBe('release');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(caseRoot, { recursive: true, force: true }); }
});

test('missing or mismatched declared materials are rejected, not repaired', async () => {
  const root = pinnedRoot();
  const caseRoot = scratch();
  const out = scratchOutput(caseRoot);
  const archive = path.join(root, 'bun-darwin-aarch64.zip');
  writeFileSync(archive, fixtureArchive());
  const manifestPath = path.join(root, 'desktop/runtime-materials/manifest.json');
  const original = readFileSync(manifestPath, 'utf8');
  try {
    // A tampered original digest must fail before anything is promoted.
    const manifest = JSON.parse(original);
    manifest.files[0].sha256 = '0'.repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(initializeRuntimeInput({ repoRoot: root, archive, output: out, fetchImpl: fixtureFetch() }))
      .rejects.toThrow('Reviewed original digest mismatch');
    // A manifest that disagrees with the pin (wrong commit) is refused.
    const mismatched = JSON.parse(original);
    mismatched.sourceCommit = 'f'.repeat(40);
    writeFileSync(manifestPath, JSON.stringify(mismatched));
    await expect(initializeRuntimeInput({ repoRoot: root, archive, output: out, fetchImpl: fixtureFetch() }))
      .rejects.toThrow('does not match the current Bun pin');
    // A missing original is an explicit failure, never silently skipped.
    rmSync(path.join(root, 'desktop/runtime-materials/originals/LICENSE.md'));
    writeFileSync(manifestPath, original);
    await expect(initializeRuntimeInput({ repoRoot: root, archive, output: out, fetchImpl: fixtureFetch() }))
      .rejects.toThrow();
  } finally { writeFileSync(manifestPath, original); rmSync(root, { recursive: true, force: true }); rmSync(caseRoot, { recursive: true, force: true }); }
});

test('a non-empty unrecognized output directory is refused and its contents survive', async () => {
  const root = pinnedRoot();
  const caseRoot = scratch();
  const out = scratchOutput(caseRoot, 'unowned');
  const archive = path.join(root, 'bun-darwin-aarch64.zip');
  writeFileSync(archive, fixtureArchive());
  mkdirSync(out, { recursive: true });
  const sentinel = path.join(out, 'user-content.txt');
  writeFileSync(sentinel, 'owned test sentinel: must survive');
  try {
    await expect(initializeRuntimeInput({ repoRoot: root, archive, output: out, fetchImpl: fixtureFetch() }))
      .rejects.toThrow('unrecognized output directory');
    // Nothing was created and the user file is byte-identical.
    expect(readFileSync(sentinel, 'utf8')).toBe('owned test sentinel: must survive');
    expect(existsSync(path.join(out, 'runtime-input.json'))).toBe(false);
    expect(readdirSync(out)).toEqual(['user-content.txt']);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(caseRoot, { recursive: true, force: true }); }
});

test('an unrecognized output that happens to hold a descriptor is still refused', async () => {
  const root = pinnedRoot();
  const caseRoot = scratch();
  const out = scratchOutput(caseRoot, 'foreign-descriptor');
  const archive = path.join(root, 'bun-darwin-aarch64.zip');
  writeFileSync(archive, fixtureArchive());
  mkdirSync(out, { recursive: true });
  // Plausible-looking but not this producer's identity (wrong source commit).
  writeFileSync(path.join(out, 'runtime-input.json'), JSON.stringify({
    mode: 'release', target: 'darwin-arm64', authority: 'authority.json', authoritySha256: '0'.repeat(64),
  }));
  writeFileSync(path.join(out, 'authority.json'), JSON.stringify({ schemaVersion: 1 }));
  try {
    await expect(initializeRuntimeInput({ repoRoot: root, archive, output: out, fetchImpl: fixtureFetch() }))
      .rejects.toThrow('unrecognized output directory');
    // The foreign files are left exactly as they were.
    expect(JSON.parse(readFileSync(path.join(out, 'runtime-input.json'), 'utf8')).authoritySha256).toBe('0'.repeat(64));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(caseRoot, { recursive: true, force: true }); }
});

test('a symlinked output destination is refused before it is followed', async () => {
  const root = pinnedRoot();
  const caseRoot = scratch();
  const parent = path.join(caseRoot, 'work');
  mkdirSync(parent, { recursive: true });
  const target = path.join(parent, 'elsewhere');
  const out = path.join(parent, 'linked-output');
  const archive = path.join(root, 'bun-darwin-aarch64.zip');
  writeFileSync(archive, fixtureArchive());
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'user-content.txt'), 'must survive symlink refusal');
  symlinkSync(target, out, 'dir');
  try {
    await expect(initializeRuntimeInput({ repoRoot: root, archive, output: out, fetchImpl: fixtureFetch() }))
      .rejects.toThrow('symlinked output directory');
    expect(readFileSync(path.join(target, 'user-content.txt'), 'utf8')).toBe('must survive symlink refusal');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(caseRoot, { recursive: true, force: true }); }
});

test('its own previous generated output is replaceable, and an empty directory initializes', async () => {
  const root = pinnedRoot();
  const caseRoot = scratch();
  const out = scratchOutput(caseRoot, 'generated');
  const archive = path.join(root, 'bun-darwin-aarch64.zip');
  writeFileSync(archive, fixtureArchive());
  try {
    // Empty directory: legitimate initialization.
    mkdirSync(out, { recursive: true });
    const first = await initializeRuntimeInput({ repoRoot: root, archive, output: out, fetchImpl: fixtureFetch() });
    const original = readFileSync(first.descriptor, 'utf8');
    // Prior generated output: idempotent replacement of its own artifacts.
    const second = await initializeRuntimeInput({ repoRoot: root, archive, output: out, fetchImpl: fixtureFetch() });
    expect(second.inputHash).toBe(first.inputHash);
    expect(readFileSync(second.descriptor, 'utf8')).toBe(original);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(caseRoot, { recursive: true, force: true }); }
});

test('a corrupted cached archive in owned output is repaired by the pin check', async () => {
  const root = pinnedRoot();
  const caseRoot = scratch();
  const out = scratchOutput(caseRoot, 'generated');
  const archive = path.join(root, 'bun-darwin-aarch64.zip');
  writeFileSync(archive, fixtureArchive());
  try {
    await initializeRuntimeInput({ repoRoot: root, archive, output: out, fetchImpl: fixtureFetch() });
    // Corrupt the cached archive inside this producer's own output.
    writeFileSync(path.join(out, 'bun-darwin-aarch64.zip'), 'corrupted');
    let calls = 0;
    const fetchImpl = (async (url: string) => {
      if (url === SOURCE_ARCHIVE_URL) return new Response(fixtureSourceArchive(), { status: 200 });
      if (url !== OFFICIAL_ARCHIVE_URL) throw new Error(`unexpected network request: ${url}`);
      calls++;
      return new Response(fixtureArchive(), { status: 200 });
    }) as unknown as typeof fetch;
    const repaired = await initializeRuntimeInput({ repoRoot: root, output: out, fetchImpl });
    expect(repaired.archiveSource).toBe('pin-download');
    expect(calls).toBe(1);
    expect(hash(readFileSync(path.join(out, 'bun-darwin-aarch64.zip')))).toBe(archiveSha());
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(caseRoot, { recursive: true, force: true }); }
});
