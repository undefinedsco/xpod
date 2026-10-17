import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPlainPath, readExternalRefreshFixture, externalRefreshPrivateRoot, verifyExternalRefreshStorage } from '../tests/helpers/browserExternalRefreshFixture';
import { runOwnedSessionCommand } from '../tests/helpers/runOwnedSessionCommand';
import { cleanupOwnedHostGroup, type OwnedHostGroup } from '../tests/helpers/ownedElectronHost';
import { deriveRefreshConfig, type RefreshProfile } from '../tests/helpers/browserRefreshPolicy';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { validateReceipt } = createRequire(import.meta.url)('./lib/service-image-session-contract.cjs');
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function writePrivate(filename: string, value: unknown): void {
  assertPlainPath(path.dirname(filename), 'directory');
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}
async function run(filename: string): Promise<void> {
  if (process.platform !== 'linux') throw new Error('Image session runner requires Linux process-group evidence');
  const { input } = readExternalRefreshFixture(filename, true);
  if (!process.versions.bun) throw new Error('Session runner requires the declared Bun toolchain');
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (source !== input.sourceSha) throw new Error('Session helper source SHA mismatch');
  const observation = path.join(input.outputDirectory, 'observations.safe.json');
  const receiptPath = path.join(input.outputDirectory, 'session.safe.json');
  const privateOutput = externalRefreshPrivateRoot(input);
  if ([observation, receiptPath, privateOutput, path.join(input.outputDirectory, 'lifecycle.safe.json')].some(existsSync)) throw new Error('Session output already exists');
  await verifyExternalRefreshStorage(input);
  assertPlainPath(path.dirname(privateOutput), 'directory');
  mkdirSync(privateOutput, { mode: 0o700 });
  const { LIMITS } = createRequire(import.meta.url)('./lib/service-image-modes.cjs');
  // A owns the 300s profile budget and grants this B process 10s cancellation grace.
  // B reserves 30s at the end and uses the helper's explicit 1s child grace.
  const result = await runOwnedSessionCommand(process.execPath, ['x', '--no-install', 'playwright', 'test',
    'tests/e2e/browser-session-refresh.spec.ts', '--workers=1', '--max-failures=1', '--reporter=line',
    '--output', path.join(privateOutput, 'playwright')], {
    cwd: root, env: { ...process.env, XPOD_E2E_REFRESH_MANIFEST: path.resolve(filename) },
    timeoutMs: LIMITS.browserMs - 30_000, outputBytes: 1024 * 1024,
  });
  // Electron creates independent groups. Even a cancelled Playwright must not
  // orphan them: only the two pre-host observer's recorded launch PIDs are owned.
  const hostCleanup = await Promise.all(['initial', 'restart'].map(async (phase): Promise<{ phase: string; observed: boolean; pid?: number; groupAbsent?: boolean; forcedCleanup?: boolean; ownershipUnknown?: boolean; invalid?: boolean }> => {
    const filename = path.join(privateOutput, `${phase}-observer.safe.json`);
    if (!existsSync(filename)) return { phase, observed: false };
    try {
      assertPlainPath(filename, 'file', true);
      const { hostPid } = JSON.parse(readFileSync(filename, 'utf8'));
      if (!Number.isSafeInteger(hostPid) || hostPid <= 1) throw new Error('Invalid recorded host PID');
      const record: OwnedHostGroup = { pid: hostPid, exitObserved: false, closeObserved: false, closeReturned: false,
        exitCode: null, signal: null, groupAbsent: false, forcedCleanup: false, ownershipUnknown: false };
      await cleanupOwnedHostGroup(record);
      return { phase, observed: true, pid: hostPid, groupAbsent: record.groupAbsent,
        forcedCleanup: record.forcedCleanup, ownershipUnknown: record.ownershipUnknown };
    } catch { return { phase, observed: true, invalid: true }; }
  }));
  const lifecycle = { ...result.record, exitCode: result.record.code, hostCleanup };
  // Preserve sole private failure originals outside safe output; A must never upload them.
  for (const [name, data] of [['stdout.private.log', result.stdout], ['stderr.private.log', result.stderr]] as const) {
    writeFileSync(path.join(privateOutput, name), data, { mode: 0o600, flag: 'wx' });
  }
  writePrivate(path.join(input.outputDirectory, 'lifecycle.safe.json'), lifecycle);
  if (lifecycle.code !== 0 || lifecycle.signal || !lifecycle.waitKnown || !lifecycle.closeObserved || !lifecycle.groupAbsent
    || lifecycle.timedOut || lifecycle.cancelled || lifecycle.forcedCleanup || lifecycle.spawnFailed
    || lifecycle.ownershipUnknown || lifecycle.outputTruncated
    || !hostCleanup.every(row => row.observed && row.groupAbsent && !row.forcedCleanup && !row.ownershipUnknown && !row.invalid)) throw new Error('Session browser process lifecycle failed');
  assertPlainPath(observation, 'file', true);
  const observed = JSON.parse(readFileSync(observation, 'utf8'));
  if (observed.status !== 'passed') throw new Error('Session observations failed');
  if (!Array.isArray(observed.hostGroups) || observed.hostGroups.length !== 2
    || hostCleanup.some((row, index) => row.pid !== observed.hostGroups[index].pid)) throw new Error('Session host PID binding mismatch');
  const sources = Object.fromEntries([
    'scripts/accept-service-image-session.ts', 'scripts/lib/service-image-session-contract.cjs',
    'tests/e2e/browser-session-refresh.spec.ts', 'tests/helpers/browserExternalRefreshFixture.ts',
    'tests/helpers/browserRefreshPolicy.ts', 'tests/helpers/browserExternalRp.ts',
    'tests/helpers/browserSolidOidc.ts', 'tests/helpers/browserXpodRuntime.ts',
    'packages/solid-sdk/src/local-route-fetch.ts', 'scripts/lib/owned-mode-command.cjs',
    'tests/helpers/runOwnedSessionCommand.ts', 'tests/helpers/ownedElectronHost.ts',
    'tests/helpers/desktopSessionObserver.cjs',
  ].map(relative => [relative, sha(readFileSync(path.join(root, relative)))]));
  const bytes = readFileSync(observation);
  const receipt = { schemaVersion: 1, status: 'passed', sourceSha: input.sourceSha, mode: input.mode,
    image: input.image, profile: input.profile, binding: input.binding,
    browser: observed.browser, sdk: observed.sdk, cleanup: observed.cleanup,
    derivedBuildBindings: { 'desktop/dist/main.js': sha(readFileSync(path.join(root, 'desktop/dist/main.js'))) },
    buildBindingSemantics: 'current generated host bytes only; not independent compilation proof',
    lifecycle,
    originals: [observation, path.join(input.outputDirectory, 'lifecycle.safe.json')].map(filename => {
      const original = filename === observation ? bytes : readFileSync(filename);
      return { path: path.basename(filename), bytes: original.length, sha256: sha(original) };
    }), sources };
  validateReceipt(receipt, input);
  writePrivate(receiptPath, receipt);
  rmSync(privateOutput, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'derive-config' && args.length === 4) {
    const [original, derived, profile, receipt] = args;
    assertPlainPath(original, 'file');
    for (const filename of [derived, receipt]) assertPlainPath(path.dirname(filename), 'directory');
    if (new Set([original, derived, receipt].map(x => path.resolve(x))).size !== 3) throw new Error('Config outputs must be distinct');
    const result = deriveRefreshConfig(readFileSync(original, 'utf8'), profile as RefreshProfile);
    writeFileSync(derived, result.config, { mode: 0o600, flag: 'wx' });
    try {
      writePrivate(receipt, { originalConfigSHA256: result.originalSha256, derivedConfigSHA256: result.derivedSha256,
        ...createRequire(import.meta.url)('./lib/service-image-session-contract.cjs').PROFILES[profile] });
    } catch (error) { rmSync(derived); throw error; }
    chmodSync(derived, 0o600);
  } else if (command === 'run' && args.length === 1) await run(args[0]);
  else throw new Error('Expected derive-config ORIGINAL DERIVED PROFILE RECEIPT or run PRIVATE_MANIFEST');
}
await main().catch(() => { console.error('Service image session acceptance failed; private diagnostics were not exported'); process.exitCode = 1; });
