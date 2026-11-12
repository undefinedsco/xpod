/**
 * DIAGNOSTIC_NOT_QUALIFICATION.
 *
 * Runs ONLY launchOwnedPackagedDesktop + close against a built candidate desktop
 * artifact and reports the last closed-enum launch subphase, so a failure can be
 * located without republishing raw private evidence.
 *
 * It never runs the full permission acceptance, never contacts the remote
 * issuer, never reads production credentials and never grants anything. Only a
 * closed-enum phase and the reviewed code enter the uploaded record; the raw
 * error survives ONLY in the 0600 private directory, which is never uploaded.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchOwnedPackagedDesktop, isLaunchSubphase, type LaunchSubphase,
  type OwnedPackagedDesktop } from '../helpers/packaged-desktop-fixture';

const SAFE = 'diagnostic-safe.json';

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing required argument --${name}`);
  return value;
}

async function main(): Promise<void> {
  const archive = path.resolve(argument('archive'));
  const version = argument('version');
  const sourceSha = argument('source-sha');
  const output = path.resolve(argument('output'));
  const issuer = argument('issuer');
  await mkdir(output, { recursive: true, mode: 0o700 });
  const privateDirectory = path.join(output, 'private');
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });

  let lastPhase: LaunchSubphase | undefined;
  let fixture: OwnedPackagedDesktop | undefined;
  let launchError: unknown;
  let cleanup: 'closed' | 'failed' | 'unproven' = 'unproven';
  const record: Record<string, unknown> = {
    schemaVersion: 1, kind: 'desktop-launch-diagnostic',
    diagnosticOnly: true, qualification: false,
    sourceSha, version, archive: path.basename(archive),
    originalSourceSha: '021c809886629624934826f4aacf87ff59326932',
    // Full app identity from the RC410 cleanup readback, never a short prefix.
    originalAppDigest: 'sha256:b1adca8a6ddb16b2c80e3685cee7da76b7fedd46476798ec043c7943b2deb69d',
  };
  try {
    fixture = await launchOwnedPackagedDesktop({ archive, version, issuer, evidenceDirectory: privateDirectory,
      onPhase: (phase) => {
        // ONE shared guard: the fixture owns the vocabulary, this script does not.
        if (!isLaunchSubphase(phase)) return;
        lastPhase = phase;
        console.log(JSON.stringify({ stage: 'launch', phase }));
      } });
    record.outcome = 'reached-local-edition';
  } catch (error) {
    launchError = error;
    record.outcome = 'failed';
    record.code = 'packaged-launch';
    record.phase = isLaunchSubphase(lastPhase) ? lastPhase : 'install';
  } finally {
    try {
      if (fixture) { await fixture.close(); cleanup = 'closed'; }
    } catch { cleanup = 'failed'; }
    // The launch helper may itself have failed to prove close; in that case the
    // cleanup result is UNPROVEN, never a false "closed".
    record.cleanup = cleanup;
    if (launchError !== undefined || cleanup !== 'closed') {
      // Raw detail stays PRIVATE and 0600: never uploaded, never printed.
      await writeFile(path.join(privateDirectory, 'failure-private.json'),
        JSON.stringify({ phase: record.phase, error: serialize(launchError), cleanup }, null, 2) + '\n',
        { mode: 0o600 });
    }
    await writeFile(path.join(output, SAFE), JSON.stringify(record, null, 2) + '\n', { mode: 0o644 });
    // Owned-cleanup rule: only remove scratch once close PROVED success. A
    // launched-but-unproven fixture must not look tidy.
    if (cleanup === 'closed') await rm(privateDirectory, { recursive: true, force: true }).catch(() => {});
  }
  // A launched-but-not-cleaned run is never a success exit.
  if (record.outcome !== 'reached-local-edition' || cleanup !== 'closed') process.exitCode = 1;
}

/** Keeps the ORIGINAL error for private debugging; never serialized publicly. */
function serialize(error: unknown): unknown {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack,
      cause: serialize((error as Error & { cause?: unknown }).cause) };
  }
  return { name: 'unknown', message: String(error) };
}

void main();
