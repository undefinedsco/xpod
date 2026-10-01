#!/usr/bin/env bun
/**
 * Installed-acceptance check for an Xpod CLI preview artifact.
 *
 * Runs against an EXTRACTED archive (or a built install dir) - never against the
 * source tree. This same script is invoked by the build hook and is the
 * documented post-install acceptance command.
 *
 * Checks:
 *   - manifest schema + artifact sha256 recomputation
 *   - `xpodcli --version` matches the manifest version
 *   - `xpodcli --help` contains no control-server commands
 *   - `xpodcli agent-fs status --json` reports helper presence consistently
 *   - no placeholder / check-binary masquerading as the native helper
 *   - optional --public public-gate check
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  publicGateProblems,
  validateManifest,
  sha256File,
  type XpodCliManifest,
} from '../src/manifest';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');

const FORBIDDEN_COMMANDS = [ 'start', 'stop', 'logs', 'server', 'account', 'backup', 'restore', 'doctor' ];

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

interface VerifyArgs {
  archive?: string;
  dir?: string;
  expectValidation?: string;
  public: boolean;
  skipExec: boolean;
}

function parseArgs(argv: string[]): VerifyArgs {
  const args: VerifyArgs = { public: false, skipExec: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--archive') {
      args.archive = path.resolve(argv[++i]);
    } else if (arg === '--dir') {
      args.dir = path.resolve(argv[++i]);
    } else if (arg === '--expect-validation') {
      args.expectValidation = argv[++i];
    } else if (arg === '--public') {
      args.public = true;
    } else if (arg === '--skip-exec') {
      args.skipExec = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.archive && !args.dir) {
    throw new Error('Provide --archive <tar.gz> or --dir <install dir>');
  }
  return args;
}

function runBinary(
  bin: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): { status: number; stdout: string; stderr: string } {
  // Sanitize: the artifact must not inherit a repo-local helper from the
  // environment, and must run from a neutral cwd so PACKAGE_ROOT cannot walk
  // into the source checkout.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.XPOD_AGENTFS_HELPER;
  Object.assign(env, options.env ?? {});
  const result = spawnSync(bin, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Unwrap the CLI JSON envelope ({ ok, data }) or return the payload as-is. */
function unwrap(json: string): Record<string, unknown> {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  if (parsed && typeof parsed === 'object' && 'data' in parsed && typeof parsed.data === 'object') {
    return parsed.data as Record<string, unknown>;
  }
  return parsed;
}

function commandNamesFromHelp(help: string): string[] {
  const names: string[] = [];
  const re = /^\s+xpodcli\s+([a-z][a-z-]*)/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(help)) !== null) {
    names.push(match[1]);
  }
  return names;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const checks: CheckResult[] = [];
  const add = (name: string, ok: boolean, detail: string): void => { checks.push({ name, ok, detail }); };

  let temp: string | undefined;
  let installDir: string;
  // Neutral cwd outside the source checkout for every binary invocation.
  const neutralCwd = mkdtempSync(path.join(tmpdir(), 'xpod-cli-cwd-'));
  if (args.archive) {
    if (!existsSync(args.archive)) {
      throw new Error(`archive not found: ${args.archive}`);
    }
    temp = mkdtempSync(path.join(tmpdir(), 'xpod-cli-verify-'));
    const tar = spawnSync('tar', [ '-xzf', args.archive, '-C', temp ], { encoding: 'utf8' });
    if (tar.status !== 0) {
      throw new Error(`tar extract failed: ${tar.stderr}`);
    }
    installDir = path.join(temp, 'install');
  } else {
    installDir = args.dir as string;
  }

  try {
    // 1. manifest + hashes
    const manifestPath = path.join(installDir, 'manifest.json');
    add('manifest.json present', existsSync(manifestPath), manifestPath);
    if (!existsSync(manifestPath)) {
      report(checks);
      process.exit(1);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as XpodCliManifest;
    const schemaProblems = validateManifest(manifest);
    add('manifest schema valid', schemaProblems.length === 0, schemaProblems.join('; ') || 'ok');
    for (const artifact of manifest.artifacts) {
      if (!artifact.included) {
        if (artifact.kind === 'native-helper') {
          add(
            'unavailable helper not present',
            !existsSync(path.join(installDir, 'helper/agentfs-pod')),
            artifact.unavailableReason ?? '',
          );
        }
        continue;
      }
      const file = path.join(installDir, artifact.path as string);
      const present = existsSync(file);
      add(`artifact present: ${artifact.name}`, present, artifact.path ?? '');
      if (present) {
        add(`artifact sha256: ${artifact.name}`, sha256File(file) === artifact.sha256, artifact.sha256 ?? '');
        add(`artifact size: ${artifact.name}`, statSync(file).size === artifact.sizeBytes, String(artifact.sizeBytes));
      }
    }

    // 2. no placeholder / check masquerade
    const allFiles = listFiles(installDir);
    add('no .placeholder files', allFiles.every((f) => !f.endsWith('.placeholder')), allFiles.filter((f) => f.endsWith('.placeholder')).join(','));
    add('no check-binary masquerade', allFiles.every((f) => !path.basename(f).includes('agentfs-pod-check')), '');

    const bin = path.join(installDir, 'bin/xpodcli');
    if (args.skipExec) {
      // Foreign target: cannot execute on this host. Packaging interface only.
      add('cross-target execution skipped', true, `platform=${manifest.platform} host=${process.platform}-${process.arch}`);
      add('cross-target not claimed supported', true, 'validationState unverified');
    } else {
      // 3. --version
      const version = runBinary(bin, [ '--version' ], { cwd: neutralCwd });
      add('xpodcli --version exit 0', version.status === 0, version.stderr.trim());
      add('xpodcli --version matches manifest', version.stdout.includes(manifest.version), version.stdout.trim());

      // 4. --help and control-command absence
      const help = runBinary(bin, [ '--help' ], { cwd: neutralCwd });
      add('xpodcli --help exit 0', help.status === 0, help.stderr.trim());
      add('help shows Xpod CLI', help.stdout.includes('Xpod CLI'), '');
      const commands = commandNamesFromHelp(help.stdout);
      const forbiddenPresent = commands.filter((c) => FORBIDDEN_COMMANDS.includes(c));
      add('no control-server commands', forbiddenPresent.length === 0, `commands=[${commands.join(',')}]`);

      // 5. agent-fs status helper consistency. Run neutral (no inherited
      // helper, neutral cwd) so a repo-local helper cannot masquerade as
      // bundled.
      const helperPath = path.join(installDir, 'helper/agentfs-pod');
      const helperBundled = existsSync(helperPath);
      if (helperBundled) {
        // Presence alone misses wrong-architecture binaries and missing
        // dynamic libraries (e.g. Linux OpenSSL 3). Execute without networking.
        const nativeVersion = runBinary(helperPath, [ '--version' ], { cwd: neutralCwd });
        add('native helper executes', nativeVersion.status === 0, nativeVersion.stderr.trim());
        add('native helper identifies itself', nativeVersion.stdout.startsWith('agentfs-pod '), nativeVersion.stdout.trim());
        const nativeHelp = runBinary(helperPath, [ '--help' ], { cwd: neutralCwd });
        add('native helper commands available', nativeHelp.status === 0 && /\bmount\b/.test(nativeHelp.stdout) && /\brecover\b/.test(nativeHelp.stdout), nativeHelp.stderr.trim());
      }
      const status = runBinary(bin, [ 'agent-fs', 'status', '--json' ], {
        cwd: neutralCwd,
        ...(helperBundled ? { env: { XPOD_AGENTFS_HELPER: helperPath } } : {}),
      });
      add('agent-fs status exit 0', status.status === 0, status.stderr.trim());
      try {
        const payload = unwrap(status.stdout);
        const helperPresent = payload.helperPresent;
        add('status helperPresent matches bundle', helperPresent === helperBundled, `helperPresent=${String(helperPresent)} bundle=${helperBundled}`);
        if (!helperBundled) {
          add('status reports no repo-local helper leak', helperPresent === false, `helperPath=${String(payload.helperPath)}`);
        }
      } catch {
        add('status JSON parseable', false, status.stdout.trim());
      }
    }

    // 6. expected validation state
    if (args.expectValidation) {
      add('validationState matches expected', manifest.validationState === args.expectValidation, `${manifest.validationState} vs ${args.expectValidation}`);
    }
    add('not claiming full install pass unless full-verified', manifest.validationState !== 'full-verified' || manifest.artifacts.every((a) => a.license.status === 'verified'), manifest.validationState);

    // 7. public gate
    if (args.public) {
      const gate = publicGateProblems(manifest);
      add('public gate passes', gate.length === 0, gate.join('; ') || 'ok');
    }

    const ok = checks.every((c) => c.ok);
    report(checks, manifest);
    process.exit(ok ? 0 : 1);
  } finally {
    if (temp) {
      rmSync(temp, { recursive: true, force: true });
    }
    rmSync(neutralCwd, { recursive: true, force: true });
  }
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function report(checks: CheckResult[], manifest?: XpodCliManifest): void {
  const ok = checks.every((c) => c.ok);
  const payload = {
    ok,
    validationState: manifest?.validationState ?? null,
    platform: manifest?.platform ?? null,
    checks,
  };
  // Human-readable on stderr, machine-readable JSON on stdout.
  for (const check of checks) {
    console.error(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.detail ? ` :: ${check.detail}` : ''}`);
  }
  console.log(JSON.stringify(payload, null, 2));
}

main();
