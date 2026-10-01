#!/usr/bin/env bun
/**
 * Build a reviewable Xpod CLI preview artifact.
 *
 * Modes:
 *   --cli-only            Build only the CLI (no native helper). Never a full
 *                         install pass; manifest is marked `cli-only`.
 *   (default, full)       Require a real AgentFS helper via --helper /
 *                         XPOD_AGENTFS_HELPER / the tools/agentfs-pod build
 *                         output. If absent: fail with "unavailable" (exit 3).
 *                         A check binary or empty/script stand-in is NEVER
 *                         silently substituted.
 *
 * Outputs an install dir, a tar.gz archive, a manifest and a verification log
 * under `.test-data/agent-directory-workers/xpod-cli-package/out/`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, cpSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MANIFEST_SCHEMA_VERSION,
  XPOD_CLI_PACKAGE,
  XPOD_CLI_VERSION,
  sha256File,
  validateManifest,
  type ManifestArtifact,
  type SelectedEnginePin,
  type XpodCliManifest,
} from '../src/manifest';
import { assertNativeTarget, bunCompileArguments, bunCompileEnvironment, bunCompileTarget } from '../src/native-target';
import { copyNativeNotices } from '../src/native-notices';
import { copyNativeDeclarations } from '../src/native-declarations';
import { collectJavascriptNotices } from '../src/javascript-notices';
import { exportApplicationSources } from '../src/application-sources';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const repoRoot = path.resolve(packageRoot, '../..');

interface Args {
  target: string;
  cliOnly: boolean;
  helper?: string;
  outDir: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    target: defaultTarget(),
    cliOnly: false,
    outDir: path.join(repoRoot, '.test-data/agent-directory-workers/xpod-cli-package/out'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cli-only') {
      args.cliOnly = true;
    } else if (arg === '--target') {
      args.target = argv[++i];
    } else if (arg === '--helper') {
      args.helper = path.resolve(argv[++i]);
    } else if (arg === '--out') {
      args.outDir = path.resolve(argv[++i]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function defaultTarget(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `${process.platform}-${arch}`;
}

function run(cmd: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`command failed (${result.status}): ${cmd} ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return result.stdout ?? '';
}

function git(args: string[]): string | null {
  const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout ?? '';
}

interface SourceIdentity {
  commit: string | null;
  dirty: boolean;
  dirtyTreeHash: string | null;
}

function readSourceIdentity(): SourceIdentity {
  const commit = (git([ 'rev-parse', 'HEAD' ]) ?? '').trim() || null;
  const status = git([ 'status', '--porcelain' ]) ?? '';
  const dirty = status.trim().length > 0;
  let dirtyTreeHash: string | null = null;
  if (dirty) {
    const diff = git([ 'diff', 'HEAD' ]) ?? '';
    const hash = createHash('sha256').update(diff).update('\n--status--\n').update(status);
    // New implementation files are untracked until commit. Hash their bytes,
    // not only filenames, so two different local candidates cannot share an ID.
    const untracked = (git([ 'ls-files', '--others', '--exclude-standard', '-z' ]) ?? '').split('\0').filter(Boolean).sort();
    for (const name of untracked) {
      hash.update('\0').update(name).update('\0').update(readFileSync(path.join(repoRoot, name)));
    }
    dirtyTreeHash = hash.digest('hex');
  }
  return { commit, dirty, dirtyTreeHash };
}

function resolveHelper(args: Args): string | undefined {
  // `XPOD_CLI_DISABLE_REPO_HELPER=1` exercises the fail-closed/unavailable path
  // without touching another worker's tools/agentfs-pod build.
  const disableRepoSearch = process.env.XPOD_CLI_DISABLE_REPO_HELPER === '1';
  const explicit = args.helper ?? process.env.XPOD_AGENTFS_HELPER;
  const candidates = explicit ? [ explicit ] : [
    ...(disableRepoSearch ? [] : [
      path.join(repoRoot, 'tools/agentfs-pod/target/release/agentfs-pod'),
      path.join(repoRoot, 'tools/agentfs-pod/target/debug/agentfs-pod'),
    ]),
  ];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function selectedEnginePin(): SelectedEnginePin {
  return {
    engine: 'agentfs',
    repository: 'https://github.com/tursodatabase/agentfs',
    commit: '0a014ebd4918615baff589ed17486e557e7c6a23',
    // Verified: sdk/rust/Cargo.toml declares license = "MIT".
    sdkLicenseStatus: 'verified',
    // Upgraded only after the pinned declaration/terms material is verified and bundled.
    cliLicenseStatus: 'pending',
    // Informational source layout; not an independent release requirement.
    rootLicensePresent: false,
  };
}

function notes(target: string, args: Args, helper?: string): string[] {
  const list = [
    'Preview artifact only; not published. Channel selection awaits user reply.',
    'CLI bundles the auth and agent-fs command registrations; control-server commands are not registered.',
    `Target platform: ${target}.`,
    'Pinned AgentFS and crate declarations plus selected standard MIT terms are bundled; full helper and Bun runtime release review remains pending.',
    'rclone (MIT) is a research backend only and is NOT part of this artifact.',
  ];
  if (!target.startsWith('darwin-arm64')) {
    list.push(`Platform ${target} packaging interface only; no real native helper/OS mount verified for this target. Not claimed as supported.`);
  }
  if (args.cliOnly || !helper) {
    list.push('CLI-only build: native helper absent, install validation is not a full pass.');
  } else if (helper.includes(`${path.sep}debug${path.sep}`)) {
    list.push('Bundled native helper is a DEBUG build (no release helper found); not a release artifact.');
  }
  return list;
}

function artifact(name: string, kind: ManifestArtifact['kind'], included: boolean, info: {
  relPath?: string; sha?: string; size?: number; license: ManifestArtifact['license']; unavailableReason?: string;
}): ManifestArtifact {
  return {
    name,
    kind,
    path: included ? info.relPath ?? null : null,
    sha256: included ? info.sha ?? null : null,
    sizeBytes: included ? info.size ?? null : null,
    included,
    license: info.license,
    ...(info.unavailableReason ? { unavailableReason: info.unavailableReason } : {}),
  };
}

function writeNotices(dir: string, target: string, includeNative: boolean, pin: SelectedEnginePin): ManifestArtifact[] {
  const text = `# Xpod CLI NOTICES (preview)

This preview artifact bundles the Xpod CLI (auth + agent-fs client commands).
It does NOT bundle the Xpod server runtime.

## Selected engine dependency: AgentFS
- Repository: https://github.com/tursodatabase/agentfs
- Commit: 0a014ebd4918615baff589ed17486e557e7c6a23
- SDK (sdk/rust): license = "MIT" (declared in Cargo.toml).
- Whole-project README explicitly declares MIT; CLI Cargo.toml lacks a field.
- Repository root: NO LICENSE/COPYING file found; only third-party licenses
  under licenses/ (fuser, nfsserve).

Pinned release declarations and selected MIT terms are bundled under
licenses/native/declarations/. The standard SPDX template retains its literal
placeholders: it is standard license text, not an invented upstream copyright
notice. AgentFS README, SDK Cargo manifest and three registry crate manifests
are preserved unmodified with their source identities and hashes. No holder or
year is invented. Original notices remain in their existing collections.
Whole-artifact release review remains pending; public release remains blocked.

Unmodified vendored fuser (MIT) and nfsserve (BSD-3-Clause) notices are bundled
under licenses/agentfs/. Their hashes are included in manifest.json. These
are third-party notices, not substitutes for AgentFS's own copyright notice.

Pinned Turso and SimSIMD original texts are bundled under licenses/native/.
Linux additionally includes the separately vendored libaegis C-backend notice.
The Cargo target/features inventories include build dependencies and remain
research evidence; these supplements are not a complete release clearance.
CLI/Bun runtime notices and remaining whole-artifact obligations still need review.
The JavaScript inputs and available package notice originals from this exact
compile are included under licenses/javascript/. Missing originals and external
imports remain visible in index.json. This excludes the embedded Bun runtime.
${includeNative ? `The target's audited Cargo notice candidates are included under
licenses/native/collection/ with original paths and content hashes. This is
a partial collection, including build dependencies, not a legal clearance.`
  : 'CLI-only build: native dependency notice collection is not included.'}
${includeNative ? `
## MPL-covered source: option-ext 0.2.0
The native dependency graph includes unmodified option-ext 0.2.0 (MPL-2.0).
Corresponding source is available at:
https://static.crates.io/crates/option-ext/option-ext-0.2.0.crate
Archive SHA-256: 04744f49eae99ab78e0d5c0b603ab218f515ea8cfe5a456d7629ad883a3b6e7d
The original MPL text is included at:
licenses/native/collection/objects/66a3107d5ad6a058aab753eaac2047ccb2ed0e39465dd0fe5844da3e300d5172.txt
License terms: https://www.mozilla.org/en-US/MPL/2.0/
This notice concerns that covered source; it does not assign MPL to the whole CLI.
` : ''}

## Not included
- rclone (MIT): research backend only, not part of this artifact.
`;
  writeFileSync(path.join(dir, 'NOTICES.md'), text, 'utf8');
  const supplements = [
    [ 'agentfs', 'LICENSE-fuser.md', 'MIT', 'e5de4041803ce3d7b1b269165677baabbeb9e43252ad176a877bd544ca04d748', 'Pinned AgentFS licenses/LICENSE-fuser.md' ],
    [ 'agentfs', 'LICENSE-nfsserve.md', 'BSD-3-Clause', '99cbb513e18ecf180a25f5c2e8f2980a91ead909c191fd4c34323497d13a3c74', 'Pinned AgentFS licenses/LICENSE-nfsserve.md' ],
    [ 'native', 'LICENSE-turso.md', 'MIT', 'b646f9ee8bcaf87e8de75153b9df7a2861c7ac445c87e741768b3c2bccf47bc5', 'https://github.com/tursodatabase/turso/blob/dc7781a52b888e323bb12e76c2793d3bab5f9106/LICENSE.md' ],
    [ 'native', 'LICENSE-simsimd.txt', 'Apache-2.0', 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4', 'https://github.com/ashvardanian/SimSIMD/blob/fb7cbdda3d187e4875cef71f2d16c1b739bff38f/LICENSE' ],
    ...(target.startsWith('linux-') ? [ [ 'native', 'LICENSE-libaegis.txt', 'MIT', '2239900b73e88ac9f37bd9fdf5d668fa67862645b983fc2ee5a4c20095aa5fe7', 'https://github.com/jedisct1/libaegis/blob/3992508d3c9dfd87ed7ed769e65bb26a9281e592/LICENSE' ] ] : []),
  ].map(([ folder, name, spdx, expected, origin ]) => {
    const source = path.join(packageRoot, 'licenses', folder, name);
    const sha = sha256File(source);
    if (sha !== expected) { throw new Error(`Pinned vendored notice changed: ${name}`); }
    const destination = path.join(dir, 'licenses', folder, name);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination);
    return artifact(name, 'notice', true, {
      relPath: `licenses/${folder}/${name}`, sha, size: statSync(destination).size,
      license: { spdx, status: 'verified', source: `${origin}; unmodified` },
    });
  });
  const collection = path.join(packageRoot, 'licenses/native/collection');
  const declarationsOutput = path.join(dir, 'licenses/native/declarations');
  const inventory = includeNative ? JSON.parse(readFileSync(path.join(collection, `${target}.json`), 'utf8')) : undefined;
  const declarations = copyNativeDeclarations(path.join(packageRoot, 'licenses/native/declarations'), declarationsOutput, pin, inventory)
    .map((name) => {
      const file = path.join(declarationsOutput, name);
      return artifact(`native-declaration:${name}`, 'notice', true, {
        relPath: `licenses/native/declarations/${name}`, sha: sha256File(file), size: statSync(file).size,
        license: { spdx: null, status: 'verified', source: 'Pinned release declarations and selected standard terms; not whole-artifact clearance' },
      });
    });
  pin.licenseEvidence = { path: 'licenses/native/declarations/index.json', sha256: sha256File(path.join(declarationsOutput, 'index.json')) };
  pin.sdkLicenseStatus = 'verified';
  pin.cliLicenseStatus = 'verified';
  if (!includeNative) { return [...supplements, ...declarations]; }
  const collectionOutput = path.join(dir, 'licenses/native/collection');
  const collected = copyNativeNotices(collection, collectionOutput, target).map((name) => {
    const file = path.join(collectionOutput, name);
    return artifact(`native-notice:${name}`, 'notice', true, {
      relPath: `licenses/native/collection/${name}`, sha: sha256File(file), size: statSync(file).size,
      license: { spdx: null, status: 'pending', source: 'Audited normal/build notice candidates, original bytes; complete release clearance pending' },
    });
  });
  return [...supplements, ...declarations, ...collected];
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  bunCompileTarget(args.target);
  rmSync(path.join(args.outDir, args.target), { recursive: true, force: true });
  const buildRoot = path.join(args.outDir, args.target);
  const installDir = path.join(buildRoot, 'install');
  const binDir = path.join(installDir, 'bin');
  const helperDir = path.join(installDir, 'helper');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(path.join(installDir, 'config'), { recursive: true });

  const cross = args.target !== defaultTarget();
  const source = readSourceIdentity();
  const pin = selectedEnginePin();
  const helper = args.cliOnly ? undefined : resolveHelper(args);
  if (!args.cliOnly && !helper) {
    console.error('xpod-cli build: native helper unavailable.');
    console.error('  Provide a real AgentFS helper via --helper <path> or XPOD_AGENTFS_HELPER,');
    console.error('  or build tools/agentfs-pod/target/{release,debug}/agentfs-pod.');
    console.error('  Refusing to substitute a check binary, empty file or script.');
    process.exit(3);
  }
  if (helper) { assertNativeTarget(helper, args.target); }
  const vendoredNotices = writeNotices(installDir, args.target, !args.cliOnly, pin);

  // Build the CLI binary from a hermetic staging tree. Bun bakes the compiled
  // module's `__dirname` into the binary; building directly from the checkout
  // would bake the build-machine repo path into PACKAGE_ROOT and let a
  // builder-local tools/agentfs-pod helper leak into an artifact that does not
  // bundle one. The staging tree is deleted after the build, so the baked path
  // is guaranteed to be absent at verify/install time.
  const stageDir = mkdtempSync(path.join(tmpdir(), 'xpod-cli-stage-'));
  const cliOut = path.join(binDir, 'xpodcli');
  const javascriptNotices: ManifestArtifact[] = [];
  const applicationSources: ManifestArtifact[] = [];
  try {
    mkdirSync(path.join(stageDir, 'packages/xpod-cli'), { recursive: true });
    cpSync(path.join(repoRoot, 'src'), path.join(stageDir, 'src'), { recursive: true });
    cpSync(path.join(packageRoot, 'src'), path.join(stageDir, 'packages/xpod-cli/src'), { recursive: true });
    cpSync(path.join(repoRoot, 'package.json'), path.join(stageDir, 'package.json'));
    symlinkSync(path.join(repoRoot, 'node_modules'), path.join(stageDir, 'node_modules'));

    const entry = path.join(stageDir, 'packages/xpod-cli/src/main.ts');
    const metafile = path.join(buildRoot, 'javascript-metafile.json');
    const buildArgs = bunCompileArguments({ target: args.target, hostTarget: defaultTarget(), entry, outfile: cliOut, metafile });
    run(process.execPath, buildArgs, { cwd: stageDir, env: bunCompileEnvironment() });
    const collectionOutput = path.join(installDir, 'licenses/javascript');
    for (const name of collectJavascriptNotices({
      metafile, stageRoot: stageDir, repoRoot, destination: collectionOutput,
      target: args.target, cli: cliOut, bunVersion: process.versions.bun ?? 'unknown',
      supplements: path.join(packageRoot, 'licenses/javascript'),
    })) {
      const file = path.join(collectionOutput, name);
      javascriptNotices.push(artifact(`javascript-notice:${name}`, 'notice', true, {
        relPath: `licenses/javascript/${name}`, sha: sha256File(file), size: statSync(file).size,
        license: { spdx: null, status: 'pending', source: 'Exact compile inputs and original notice candidates; runtime and full audit pending' },
      }));
    }
    const sourceDirectory = path.join(buildRoot, 'application-source');
    exportApplicationSources({
      stageRoot: stageDir, repoRoot, packageRoot, notices: path.join(installDir, 'licenses'), destination: sourceDirectory,
      target: args.target, cli: cliOut, compiler: process.execPath, compilerVersion: process.versions.bun ?? 'unknown', hostTarget: defaultTarget(),
      source: { commit: source.commit, dirtyTreeHash: source.dirtyTreeHash },
    });
    const sources = path.join(installDir, 'sources');
    mkdirSync(sources, { recursive: true });
    cpSync(path.join(sourceDirectory, 'source-kit.json'), path.join(sources, 'application-source.json'));
    run('tar', ['-czf', path.join(sources, 'application-source.tar.gz'), '-C', buildRoot, 'application-source']);
    for (const name of ['application-source.json', 'application-source.tar.gz']) {
      const file = path.join(sources, name);
      applicationSources.push(artifact(name, 'source', true, {
        relPath: `sources/${name}`, sha: sha256File(file), size: statSync(file).size,
        license: { spdx: null, status: 'pending', source: 'Application bytes and installed dependencies; Bun/native-helper source and full release obligations remain separate' },
      }));
    }
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }

  const cliSha = sha256File(cliOut);
  assertNativeTarget(cliOut, args.target);
  const cliSize = statSync(cliOut).size;
  const cliArtifact = artifact('xpodcli', 'cli', true, {
    relPath: 'bin/xpodcli',
    sha: cliSha,
    size: cliSize,
    // Root package.json declares MIT but no root LICENSE file is present.
    license: { spdx: null, status: 'pending', source: 'root package.json declares MIT; no root LICENSE file present' },
  });

  // Native helper (separate artifact, never fused into the CLI executable).
  let helperArtifact: ManifestArtifact;
  if (helper) {
    mkdirSync(helperDir, { recursive: true });
    const helperOut = path.join(helperDir, 'agentfs-pod');
    cpSync(helper, helperOut);
    const helperSha = sha256File(helperOut);
    helperArtifact = artifact('agentfs-pod', 'native-helper', true, {
      relPath: 'helper/agentfs-pod',
      sha: helperSha,
      size: statSync(helperOut).size,
      license: { spdx: 'MIT', status: 'pending', source: 'Pinned declarations and terms bundled; whole native helper release review pending' },
    });
  } else {
    helperArtifact = artifact('agentfs-pod', 'native-helper', false, {
      license: { spdx: 'MIT', status: 'pending', source: 'Pinned declarations and terms bundled; whole native helper release review pending' },
      unavailableReason: args.cliOnly
        ? 'cli-only build: helper intentionally omitted'
        : 'no real AgentFS helper found (check binary/empty/script not accepted)',
    });
  }

  // Launcher: sets the EXISTING authoritative helper env key; no duplicate keys.
  const launcher = [
    '#!/bin/sh',
    '# Xpod CLI launcher: points the existing XPOD_AGENTFS_HELPER key at the bundled helper.',
    'DIR="$(cd "$(dirname "$0")/.." && pwd)"',
    'if [ -x "$DIR/helper/agentfs-pod" ]; then',
    '  XPOD_AGENTFS_HELPER="$DIR/helper/agentfs-pod"',
    '  export XPOD_AGENTFS_HELPER',
    'fi',
    'exec "$DIR/bin/xpodcli" "$@"',
    '',
  ].join('\n');
  const launcherPath = path.join(binDir, 'xpodcli-env');
  writeFileSync(launcherPath, launcher, { mode: 0o755 });

  writeFileSync(path.join(installDir, 'VERSION'), `${XPOD_CLI_VERSION}\n`, 'utf8');
  writeFileSync(path.join(installDir, 'config/minimal.json'), JSON.stringify({
    package: XPOD_CLI_PACKAGE,
    version: XPOD_CLI_VERSION,
    enginePin: { engine: pin.engine, repository: pin.repository, commit: pin.commit },
  }, null, 2) + '\n', 'utf8');

  const noticeArtifact = artifact('NOTICES.md', 'notice', true, {
    relPath: 'NOTICES.md',
    sha: sha256File(path.join(installDir, 'NOTICES.md')),
    size: statSync(path.join(installDir, 'NOTICES.md')).size,
    license: { spdx: null, status: 'verified', source: 'generated notices text' },
  });

  const manifestPath = path.join(installDir, 'manifest.json');
  const manifest: XpodCliManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    package: XPOD_CLI_PACKAGE,
    version: XPOD_CLI_VERSION,
    channel: source.dirty || !source.commit ? 'local-preview' : 'preview',
    platform: args.target,
    sourceSHA: source.commit,
    dirtyTreeHash: source.dirtyTreeHash,
    source: {
      mode: source.dirty || !source.commit ? 'local-preview' : 'release',
      commit: source.commit,
      dirty: source.dirty,
    },
    selectedEnginePin: pin,
    artifacts: [ cliArtifact, helperArtifact, noticeArtifact, ...vendoredNotices, ...javascriptNotices, ...applicationSources ],
    // A helper-present build can reach install-verified after the extraction
    // check; full-verified additionally requires verified licenses. A
    // cross-target build cannot be executed on this host and stays unverified.
    validationState: cross ? 'unverified' : helper ? 'install-verified' : 'cli-only',
    generatedAt: new Date().toISOString(),
    notes: notes(args.target, args, helper),
  };

  const problems = validateManifest(manifest);
  if (problems.length > 0) {
    throw new Error(`manifest invalid:\n  ${problems.join('\n  ')}`);
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  if (manifest.channel === 'local-preview') {
    writeFileSync(path.join(installDir, 'manifest.local.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }

  // Archive.
  const archive = path.join(buildRoot, `xpod-cli-${XPOD_CLI_VERSION}-${args.target}.tar.gz`);
  run('tar', [ '-czf', archive, '-C', buildRoot, 'install' ]);
  const archiveSha = sha256File(archive);

  // Installed acceptance: same script used for post-install verification,
  // run against the extracted archive (not the source tree).
  const verifyArgs = [
    path.join(packageRoot, 'scripts/verify-install.ts'),
    '--archive', archive,
    '--expect-validation', manifest.validationState,
  ];
  if (cross) {
    // Cannot execute a foreign-target binary on this host; packaging interface
    // only. Never claimed as verified/supported.
    verifyArgs.push('--skip-exec');
  }
  const verify = spawnSync(process.execPath, verifyArgs, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  process.stdout.write(verify.stdout ?? '');
  process.stderr.write(verify.stderr ?? '');
  if (verify.status !== 0) {
    throw new Error(`install verification failed (${verify.status})`);
  }

  const summary = {
    target: args.target,
    installDir,
    archive,
    archiveSha256: archiveSha,
    cliSize,
    helperSize: helperArtifact.sizeBytes,
    validationState: manifest.validationState,
    publicReleaseReady: false,
    publicGateNote: 'licenses pending + preview channel; public gate must block.',
  };
  writeFileSync(path.join(buildRoot, 'build-summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

main();
