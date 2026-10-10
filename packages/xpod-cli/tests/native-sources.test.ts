import { expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkNativePatch, nativeGitEnvironment, nativeWorkingLock, nativeWorkingManifest, runSourceCommand, validateNativeBuildReceipt, verifyNativeSourceArchive, verifyNativeSources, type NativeSourceKit } from '../src/native-sources';
import { sha256File } from '../src/manifest';

const engine = { repository: 'https://github.com/tursodatabase/agentfs', commit: 'a'.repeat(40) };
const originalManifest = `[dependencies]\nagentfs = { git = "${engine.repository}", rev = "${engine.commit}" }\nagentfs-sdk = { git = "${engine.repository}", rev = "${engine.commit}" }\n`;
const registryChecksum = 'b'.repeat(64);
const originalLock = `version = 4\n\n[[package]]\nname = "agentfs"\nversion = "0.6.4"\nsource = "git+${engine.repository}?rev=${engine.commit}#${engine.commit}"\n\n[[package]]\nname = "agentfs-sdk"\nversion = "0.6.4"\nsource = "git+${engine.repository}?rev=${engine.commit}#${engine.commit}"\n\n[[package]]\nname = "native-fixture"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${registryChecksum}"\n`;
const patch = (name: string): string => `diff --git a/cli/src/${name}.rs b/cli/src/${name}.rs\n--- a/cli/src/${name}.rs\n+++ b/cli/src/${name}.rs\n@@ -1 +1 @@\n-before\n+after\n`;

function fixture(run: (root: string, kit: NativeSourceKit, refresh: () => void) => void): void {
  const parent = path.resolve('.test-data/xpod-cli/native-sources');
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(path.join(parent, 'case-'));
  const root = path.join(work, 'native-source');
  const contents: Record<string, string> = {
    'original/helper/Cargo.toml': originalManifest, 'original/helper/Cargo.lock': originalLock,
    'helper/Cargo.toml': nativeWorkingManifest(originalManifest, engine), 'helper/Cargo.lock': nativeWorkingLock(originalLock, engine),
    'helper/.cargo/config.toml': '[source.crates-io]\nreplace-with = "vendored-sources"\n[source.vendored-sources]\ndirectory = "../vendor"\n',
    'helper/src/main.rs': 'fn main() {}\n', 'upstream/README.md': 'Fixture\n', 'upstream/sdk/rust/Cargo.toml': '[package]\nname = "agentfs-sdk"\n',
    'upstream/cli/src/fuse.rs': 'after\n', 'upstream/cli/src/nfs.rs': 'after\n', 'upstream/cli/src/owned.rs': 'after\n',
    'patches/fuse-revalidation.patch': patch('fuse'), 'patches/nfs-directory-cookie.patch': patch('nfs'),
    'patches/fuse-owned-session-ready.patch': patch('owned'),
    'packages/xpod-cli/scripts/rebuild-native.ts': '// fixture\n', 'packages/xpod-cli/scripts/collect-native-notices.ts': '// fixture\n',
    'original-upstream.tar': 'fixture archive\n',
    'packages/xpod-cli/src/native-sources.ts': '// fixture\n', 'packages/xpod-cli/src/source-materials.ts': '// fixture\n',
    'packages/xpod-cli/src/manifest.ts': '// fixture\n', 'packages/xpod-cli/src/native-target.ts': '// fixture\n',
    'licenses/xpod/LICENSE': 'project notice\n',
    'licenses/native/valuable-0.1.1/LICENSE': 'fixture notice\n', 'licenses/native/valuable-0.1.1/provenance.json': '{}\n',
    'licenses/native/LICENSE-turso.md': 'notice\n', 'licenses/native/LICENSE-simsimd.txt': 'notice\n', 'licenses/native/LICENSE-libaegis.txt': 'notice\n',
    'vendor/native-fixture-1.0.0/native/source.c': 'int fixture;\n',
  };
  try {
    for (const [file, text] of Object.entries(contents)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text);
    }
    const checksumPath = 'vendor/native-fixture-1.0.0/.cargo-checksum.json';
    writeFileSync(path.join(root, checksumPath), JSON.stringify({ package: registryChecksum, files: { 'native/source.c': sha256File(path.join(root, 'vendor/native-fixture-1.0.0/native/source.c')) } }));
    const kit: NativeSourceKit = { schemaVersion: 1, status: 'native-source-materials', scope: 'fixture', engine, toolchain: 'nightly-2026-09-30', registryPackages: 1, files: [] };
    const refresh = (): void => {
      kit.files = [...Object.keys(contents), checksumPath].map((file) => ({ path: file, sha256: sha256File(path.join(root, file)), sizeBytes: statSync(path.join(root, file)).size }));
      writeFileSync(path.join(root, 'source-kit.json'), JSON.stringify(kit));
    };
    refresh(); run(root, kit, refresh);
  } finally { rmSync(work, { recursive: true, force: true }); }
}

test('native patches apply and reverse-check inside an unrelated parent Git repository', () => {
  fixture((root) => {
    runSourceCommand('git', ['init', '--quiet'], path.dirname(root));
    const upstream = path.join(root, 'upstream');
    const nfs = path.join(upstream, 'cli/src/nfs.rs');
    const file = path.join(root, 'patches/nfs-directory-cookie.patch');
    writeFileSync(nfs, 'before\n');
    expect(() => checkNativePatch(upstream, file, true)).toThrow();
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(path.dirname(root), '.git');
    try { checkNativePatch(upstream, file, false); } finally {
      if (saved === undefined) { delete process.env.GIT_DIR; } else { process.env.GIT_DIR = saved; }
    }
    expect(readFileSync(nfs, 'utf8')).toBe('after\n');
    expect(() => checkNativePatch(upstream, file, true)).not.toThrow();
  });
});

test('native working lock preserves registry versions/checksums and rejects extra Git substitution', () => {
  const working = nativeWorkingLock(originalLock, engine);
  expect(working).toContain(`checksum = "${registryChecksum}"`);
  expect(working).toContain('version = "1.0.0"');
  expect(working).not.toContain('source = "git+');
  expect(() => nativeWorkingLock(originalLock + `\n[[package]]\nname = "unexpected"\nsource = "git+${engine.repository}?rev=${engine.commit}#${engine.commit}"\n`, engine)).toThrow('only two');
});

test('native build environment clears explicit Git overrides as well as parent discovery', () => {
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = '/unrelated/repository';
  try {
    const env = nativeGitEnvironment('/stage');
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_CEILING_DIRECTORIES).toBe('/stage');
  } finally {
    if (saved === undefined) { delete process.env.GIT_DIR; } else { process.env.GIT_DIR = saved; }
  }
});

test('native source archive requires its original archive and every rebuild import', () => {
  fixture((root, kit) => {
    const archive = path.join(path.dirname(root), 'source.tar.gz');
    for (const required of ['packages/xpod-cli/scripts/collect-native-notices.ts', 'patches/fuse-owned-session-ready.patch', 'licenses/xpod/LICENSE', 'licenses/native/valuable-0.1.1/LICENSE', 'licenses/native/valuable-0.1.1/provenance.json', 'original-upstream.tar', 'packages/xpod-cli/src/native-sources.ts', 'packages/xpod-cli/src/source-materials.ts', 'packages/xpod-cli/src/manifest.ts', 'packages/xpod-cli/src/native-target.ts']) {
      const incomplete = { ...kit, files: kit.files.filter((file) => file.path !== required) };
      writeFileSync(path.join(root, 'source-kit.json'), JSON.stringify(incomplete));
      runSourceCommand('tar', ['-czf', archive, '-C', path.dirname(root), 'native-source'], root);
      expect(() => verifyNativeSourceArchive(archive, readFileSync(path.join(root, 'source-kit.json')))).toThrow(`material missing: ${required}`);
    }
  });
});

test('native verifier rejects unpatched bytes even when the outer file inventory is rehashed', () => {
  fixture((root, _kit, refresh) => {
    runSourceCommand('git', ['init', '--quiet'], path.dirname(root));
    expect(verifyNativeSources(root).registryPackages).toBe(1);
    writeFileSync(path.join(root, 'upstream/cli/src/nfs.rs'), 'before\n'); refresh();
    expect(() => verifyNativeSources(root)).toThrow('git failed');
  });
});

test('native verifier rejects an unapplied ownership handshake patch even with refreshed inventory', () => {
  fixture((root, _kit, refresh) => {
    writeFileSync(path.join(root, 'upstream/cli/src/owned.rs'), 'before\n'); refresh();
    expect(() => verifyNativeSources(root)).toThrow('git failed');
  });
});

test('native verifier checks full vendor checksum coverage, including C sources', () => {
  fixture((root, kit) => {
    verifyNativeSources(root);
    kit.files = kit.files.filter((file) => !file.path.endsWith('/native/source.c'));
    writeFileSync(path.join(root, 'source-kit.json'), JSON.stringify(kit));
    expect(() => verifyNativeSources(root)).toThrow('vendor source missing');
  });
});

test('native archive verification validates applied patches and lock transformation', () => {
  fixture((root, kit, refresh) => {
    const archive = path.join(path.dirname(root), 'source.tar.gz');
    const pack = (): void => { runSourceCommand('tar', ['-czf', archive, '-C', path.dirname(root), 'native-source'], root); };
    pack(); expect(verifyNativeSourceArchive(archive, readFileSync(path.join(root, 'source-kit.json')))).toEqual(kit);
    writeFileSync(path.join(root, 'helper/Cargo.lock'), nativeWorkingLock(originalLock, engine).replace('version = "1.0.0"', 'version = "2.0.0"'));
    refresh(); pack();
    expect(() => verifyNativeSourceArchive(archive, readFileSync(path.join(root, 'source-kit.json')))).toThrow('transformation differs');
  });
});

test('native receipts bind binary, kit, compiler and target independently', () => {
  fixture((_root, kit) => {
    const receipt = { schemaVersion: 1, target: 'darwin-arm64', engine, sourceKitSha256: 'c'.repeat(64), helperSha256: 'd'.repeat(64),
      compiler: { toolchain: kit.toolchain, cargoSha256: 'e'.repeat(64), rustcSha256: 'f'.repeat(64) },
      buildArguments: ['build', '--release', '--frozen'], registryPackages: 1, sourceFiles: kit.files.length, isolatedCargoHome: true, stagedVerifiedFilesOnly: true };
    const verify = (value: unknown): void => validateNativeBuildReceipt(value, kit, receipt.sourceKitSha256, receipt.helperSha256, receipt.target);
    expect(() => verify(receipt)).not.toThrow();
    for (const change of [{ target: 'linux-arm64' }, { sourceKitSha256: '0'.repeat(64) }, { helperSha256: '0'.repeat(64) }, { stagedVerifiedFilesOnly: false }, { buildArguments: ['build'] }]) {
      expect(() => verify({ ...receipt, ...change })).toThrow('receipt differs');
    }
  });
});


test('native rebuild fixes compiler parallelism after clearing inherited build overrides', () => {
  fixture((root, _kit, refresh) => {
    for (const relative of ['scripts/rebuild-native.ts', 'scripts/collect-native-notices.ts', 'src/native-sources.ts', 'src/source-materials.ts', 'src/manifest.ts', 'src/native-target.ts']) {
      copyFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), path.join(root, 'packages/xpod-cli', relative));
    }
    refresh();
    const work = path.dirname(root);
    const tools = path.join(work, 'fake-tools');
    mkdirSync(tools);
    const cargo = path.join(tools, 'cargo');
    const rustc = path.join(tools, 'rustc');
    const triple = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-gnu'}`;
    const sysroot = path.join(work, 'fake-sysroot');
    mkdirSync(path.join(sysroot, 'share/doc/rust/licenses'), { recursive: true });
    writeFileSync(path.join(sysroot, 'share/doc/rust/COPYRIGHT-library.html'), 'synthetic sysroot copyright\n');
    writeFileSync(path.join(sysroot, 'share/doc/rust/licenses/MIT.txt'), 'synthetic sysroot notice\n');
    const capture = path.join(work, 'cargo-invocations.jsonl');
    writeFileSync(path.join(tools, 'rustup'), `#!${process.execPath}
process.stdout.write(process.argv.at(-1) === 'cargo' ? ${JSON.stringify(cargo)} : ${JSON.stringify(rustc)});
`, { mode: 0o700 });
    writeFileSync(rustc, `#!${process.execPath}
process.stdout.write(process.argv.includes('--print') ? ${JSON.stringify(sysroot)} : ${JSON.stringify('commit-hash: ' + 'a'.repeat(40) + '\nhost: ' + triple + '\n')});
`, { mode: 0o700 });
    writeFileSync(cargo, `#!${process.execPath}
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const env = Object.fromEntries(['CARGO_BUILD_JOBS', 'CARGO_HOME', 'CARGO_TARGET_DIR', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_BUILD_TARGET', 'RUSTC', 'RUSTFLAGS', 'RUSTC_WRAPPER', 'GIT_DIR'].map(key => [key, process.env[key] ?? null]));
appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2), env }) + '\\n');
if (process.argv[2] === 'build') {
  const destination = path.join(process.env.CARGO_TARGET_DIR, 'release/agentfs-pod');
  mkdirSync(path.dirname(destination), { recursive: true });
  const bytes = Buffer.alloc(32);
  if (process.platform === 'darwin') { bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(process.arch === 'arm64' ? 0x0100000c : 0x01000007, 4); }
  else { Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes); bytes.writeUInt16LE(process.arch === 'arm64' ? 183 : 62, 18); }
  writeFileSync(destination, bytes);
}
if (process.argv[2] === 'metadata') {
  process.stdout.write(JSON.stringify({ packages: [{ id: 'agentfs-pod', name: 'agentfs-pod', version: '0.1.0', source: null, license: null, license_file: null, manifest_path: path.join(process.cwd(), 'Cargo.toml') }], resolve: { root: 'agentfs-pod', nodes: [{ id: 'agentfs-pod', features: [], deps: [] }] } }));
}
`, { mode: 0o700 });
    const output = path.join(work, 'rebuild-output');
    const result = spawnSync(process.execPath, [path.join(root, 'packages/xpod-cli/scripts/rebuild-native.ts'), '--out', output, '--test'], {
      env: { ...process.env, PATH: `${tools}${path.delimiter}${process.env.PATH ?? ''}`,
        CARGO_BUILD_JOBS: '97', CARGO_HOME: '/untrusted/cargo-home', CARGO_TARGET_DIR: '/untrusted/target',
        CARGO_ENCODED_RUSTFLAGS: 'untrusted', CARGO_BUILD_TARGET: 'untrusted-target',
        RUSTC: '/untrusted/rustc', RUSTFLAGS: 'untrusted', RUSTC_WRAPPER: '/untrusted/wrapper', GIT_DIR: '/untrusted/git' },
      encoding: 'utf8',
    });
    if (result.status !== 0) { throw new Error(`Native fixture rebuild failed: ${result.stderr}`); }
    expect(result.status).toBe(0);
    const invocations = readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(invocations.map(invocation => invocation.args)).toEqual([['build', '--release', '--frozen'], ['test', '--release', '--frozen'], ['metadata', '--format-version', '1', '--frozen', '--filter-platform', triple]]);
    for (const invocation of invocations) {
      expect(invocation.env.CARGO_BUILD_JOBS).toBe('2');
      expect(invocation.env.CARGO_HOME).not.toBe('/untrusted/cargo-home');
      expect(invocation.env.CARGO_TARGET_DIR).toBe(path.join(output, 'target'));
      expect(invocation.env.RUSTC).toBe(rustc);
      for (const key of ['CARGO_ENCODED_RUSTFLAGS', 'CARGO_BUILD_TARGET', 'RUSTFLAGS', 'RUSTC_WRAPPER', 'GIT_DIR']) {
        expect(invocation.env[key]).toBeNull();
      }
    }
    const receipt = JSON.parse(readFileSync(path.join(output, 'receipt.json'), 'utf8'));
    expect(receipt.compilerParallelism).toBe(2);
    expect(receipt.buildArguments).toEqual(invocations[0].args);
    expect(receipt.testsPassed).toBe(true);
    expect(receipt.helperSha256).toBe(sha256File(path.join(output, 'agentfs-pod')));
    expect(receipt.sourceKitSha256).toBe(sha256File(path.join(root, 'source-kit.json')));
    expect(receipt.nativeNotices.indexSHA256).toBe(sha256File(path.join(output, 'native-notices', `${process.platform}-${process.arch}.json`)));
    expect(receipt.nativeNotices.provenanceSHA256).toBe(sha256File(path.join(output, 'native-notices/provenance.json')));
    console.log(JSON.stringify({ fixture: 'fake cargo, no native compilation', childInvocations: invocations.map(invocation => ({ pid: invocation.pid, args: invocation.args, jobs: invocation.env.CARGO_BUILD_JOBS })), receiptCompilerParallelism: receipt.compilerParallelism }));
  });
});
