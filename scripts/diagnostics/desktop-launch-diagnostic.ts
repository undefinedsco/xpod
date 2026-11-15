/**
 * DIAGNOSTIC_NOT_QUALIFICATION.
 *
 * Runs ONLY launchOwnedPackagedDesktop + close against a RETAINED prebuilt desktop
 * artifact (exact immutable origin) and reports the closed-enum launch subphase
 * plus the helper's bounded gateway telemetry, without republishing raw evidence.
 *
 * It never runs the full permission acceptance, never contacts the remote
 * issuer, never reads production credentials and never grants anything. Only a
 * closed-enum phase and the reviewed code enter the uploaded record; the raw
 * error survives ONLY in the 0600 private directory, which is never uploaded.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchOwnedPackagedDesktop, isLaunchSubphase, readGatewayTelemetry,
  type GatewayTelemetry, type LaunchSubphase, type OwnedPackagedDesktop } from '../helpers/packaged-desktop-fixture';

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
  const optional = (name: string): string | undefined => {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  // Immutable archive origin; the harness source is the running commit. Every
  // supplied flag is STRICT: nothing arbitrary may reach the safe record.
  const hex = (name: string, value: string, length: number): string => {
    const pattern = length === 40 ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u;
    if (!pattern.test(value)) throw new Error(`--${name} must be ${length} lowercase hex characters`);
    return value;
  };
  const digits = (name: string, value: string): string => {
    if (!/^[0-9]+$/u.test(value)) throw new Error(`--${name} must be numeric`);
    return value;
  };
  if (!/^[a-f0-9]{40}$/u.test(sourceSha)) throw new Error('--source-sha must be 40 lowercase hex characters');
  const archiveSourceSha = optional('archive-source-sha');
  const artifactId = optional('artifact-id');
  const artifactRun = optional('artifact-run');
  const memberSha256 = optional('member-sha256');
  const origin = {
    ...(archiveSourceSha ? { archiveSourceSha: hex('archive-source-sha', archiveSourceSha, 40) } : {}),
    ...(artifactId ? { artifactId: digits('artifact-id', artifactId) } : {}),
    ...(artifactRun ? { artifactRun: digits('artifact-run', artifactRun) } : {}),
    ...(memberSha256 ? { archiveMemberSha256: hex('member-sha256', memberSha256, 64) } : {}),
  };
  await mkdir(output, { recursive: true, mode: 0o700 });
  const privateDirectory = path.join(output, 'private');
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });

  let lastPhase: LaunchSubphase | undefined;
  // Fixed, closed launch phases only: no URL/path/pid can enter the record.
  const phaseTimings: { phase: LaunchSubphase; elapsedMs: number }[] = [];
  const phaseStarted = Date.now();
  let latestTelemetry: GatewayTelemetry | undefined;
  let fixture: OwnedPackagedDesktop | undefined;
  let launchError: unknown;
  let cleanup: 'closed' | 'failed' | 'unproven' = 'unproven';
  const record: Record<string, unknown> = {
    schemaVersion: 1, kind: 'desktop-launch-diagnostic',
    diagnosticOnly: true, qualification: false,
    sourceSha, version, archive: path.basename(archive),
    // Exact origin of the RETAINED app bytes; never inferred from this checkout.
    ...origin,
  };
  try {
    fixture = await launchOwnedPackagedDesktop({ archive, version, issuer, evidenceDirectory: privateDirectory,
      onPhase: (phase) => {
        // ONE shared guard: the fixture owns the vocabulary, this script does not.
        if (!isLaunchSubphase(phase)) return;
        lastPhase = phase;
        phaseTimings.push({ phase, elapsedMs: Math.max(0, Date.now() - phaseStarted) });
        console.log(JSON.stringify({ stage: 'launch', phase }));
      },
      onTelemetry: (frame) => { latestTelemetry = frame; } });
    record.outcome = 'reached-local-edition';
  } catch (error) {
    launchError = error;
    record.outcome = 'failed';
    record.code = 'packaged-launch';
    record.phase = isLaunchSubphase(lastPhase) ? lastPhase : 'install';
    // The helper attaches bounded telemetry (incl. appAlive) to the primary
    // error; prefer it over any observer frame so appAlive is preserved.
    const telemetry = readGatewayTelemetry(error) ?? readGatewayTelemetry({ gatewayTelemetry: latestTelemetry });
    if (telemetry) record.gatewayTelemetry = telemetry;
  } finally {
    try {
      if (fixture) { await fixture.close(); cleanup = 'closed'; }
    } catch { cleanup = 'failed'; }
    // The launch helper may itself have failed to prove close; in that case the
    // cleanup result is UNPROVEN, never a false "closed".
    record.cleanup = cleanup;
    if (phaseTimings.length) record.phases = phaseTimings;
    // Fallback: an observer frame still yields bounded timing on success.
    if (!record.gatewayTelemetry) {
      const telemetry = readGatewayTelemetry({ gatewayTelemetry: latestTelemetry });
      if (telemetry) record.gatewayTelemetry = telemetry;
    }
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
