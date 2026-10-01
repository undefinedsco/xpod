#!/usr/bin/env bun
/**
 * Evidence-bound promotion of an Xpod CLI install candidate.
 *
 * Ordinary builds stop at a pending candidate. This command takes an existing
 * candidate plus explicit structured acceptance/review evidence and produces a
 * SEPARATE promoted install/archive/summary. The original candidate and all of
 * its bytes are left untouched.
 *
 * It reuses the existing post-install verification (`scripts/verify-install.ts`)
 * and source/native-receipt validators, then derives a promoted manifest only
 * from complete, hash-bound evidence and computes readiness from
 * `publicGateProblems`. Missing or invalid evidence fails closed before any
 * output is written.
 *
 * Usage:
 *   bun scripts/promote.ts --candidate <install dir | candidate archive> \
 *     --evidence <promotion-evidence.json> \
 *     --installed-report <installed-acceptance.json> \
 *     --gateway-report <gateway-acceptance.json> \
 *     --out <output root> [--skip-exec]
 *
 * A single real report file containing both sections may be passed to both
 * report flags. The run refuses to overwrite an existing output target and
 * rejects any output overlapping the candidate/install/archive.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  publicGateProblems,
  sha256File,
  sha256Hex,
  type XpodCliManifest,
} from '../src/manifest';
import {
  buildPromotionRecord,
  derivePromotedManifest,
  promotionPathOverlapProblems,
  validateAcceptanceReports,
  validatePromotionEvidence,
  type PromotionEvidence,
} from '../src/promotion';
import { verifyApplicationSourceArchive } from '../src/application-sources';
import { validateNativeBuildReceipt, verifyNativeSourceArchive } from '../src/native-sources';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');

interface Args {
  candidate: string;
  evidence: string;
  installedReport: string;
  gatewayReport: string;
  out: string;
  skipExec: boolean;
}

function parseArgs(argv: string[]): Args {
  let candidate: string | undefined;
  let evidence: string | undefined;
  let installedReport: string | undefined;
  let gatewayReport: string | undefined;
  let out = path.join(packageRoot, '.test-data/promotion');
  let skipExec = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--candidate') { candidate = path.resolve(argv[++i]); }
    else if (arg === '--evidence') { evidence = path.resolve(argv[++i]); }
    else if (arg === '--installed-report') { installedReport = path.resolve(argv[++i]); }
    else if (arg === '--gateway-report') { gatewayReport = path.resolve(argv[++i]); }
    else if (arg === '--out') { out = path.resolve(argv[++i]); }
    else if (arg === '--skip-exec') { skipExec = true; }
    else { throw new Error(`Unknown argument: ${arg}`); }
  }
  if (!candidate || !evidence) {
    throw new Error('Provide --candidate <install dir | archive> and --evidence <promotion-evidence.json>');
  }
  if (!installedReport || !gatewayReport) {
    throw new Error('Provide --installed-report <file> and --gateway-report <file> (a single real report with both sections may serve both)');
  }
  return { candidate, evidence, installedReport, gatewayReport, out, skipExec };
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.stderr ?? ''}`);
  }
}

function fail(payload: Record<string, unknown>, code: number): never {
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(code);
}

function requiredArtifact(manifest: XpodCliManifest, relative: string): { path: string; sha256: string } {
  const artifact = manifest.artifacts.find((entry) => entry.included && entry.path === relative);
  if (!artifact?.path || !artifact.sha256) {
    throw new Error(`Candidate is missing included artifact ${relative}`);
  }
  return { path: artifact.path, sha256: artifact.sha256 };
}

/** Real path of `target`, or of its nearest existing ancestor (symlink-aware). */
function realpathNearest(target: string): string {
  let current = path.resolve(target);
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(current), ...suffix.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return path.resolve(target);
      }
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const hostTarget = `${process.platform}-${process.arch}`;

  let temporary: string | undefined;
  let installDir: string;
  try {
    if (args.candidate.endsWith('.tar.gz')) {
      if (!existsSync(args.candidate)) { fail({ ok: false, error: `candidate archive not found: ${args.candidate}` }, 1); }
      temporary = mkdtempSync(path.join(tmpdir(), 'xpod-cli-promote-'));
      run('tar', [ '-xzf', args.candidate, '-C', temporary ]);
      installDir = path.join(temporary, 'install');
    } else if (existsSync(path.join(args.candidate, 'install/manifest.json'))) {
      installDir = path.join(args.candidate, 'install');
    } else if (existsSync(path.join(args.candidate, 'manifest.json'))) {
      installDir = args.candidate;
    } else {
      return fail({ ok: false, error: `candidate has no manifest: ${args.candidate}` }, 1);
    }

    const manifestPath = path.join(installDir, 'manifest.json');
    const candidateManifestSha256 = sha256File(manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as XpodCliManifest;

    // 0. Refuse any output that could erase the candidate/install/archive
    //    (including a symlink alias) and never silently delete an existing
    //    output target. No output is written until every check passes.
    const targetRoot = path.join(args.out, manifest.platform);
    const candidateArchive = args.candidate.endsWith('.tar.gz') ? args.candidate : undefined;
    const overlapProblems = promotionPathOverlapProblems({
      candidate: args.candidate,
      installDir,
      ...(candidateArchive ? { archive: candidateArchive } : {}),
      out: args.out,
      targetRoot,
      targetRootExists: existsSync(targetRoot),
    }, realpathNearest);
    if (overlapProblems.length > 0) {
      return fail({ ok: false, stage: 'output-overlap', problems: overlapProblems }, 1);
    }

    // 1. Reuse the same post-install verification used by the build hook. A
    //    foreign-target candidate cannot be executed here; its installed
    //    acceptance evidence must have been produced on the actual target.
    const verifyArgs = [ path.join(packageRoot, 'scripts/verify-install.ts'), '--dir', installDir ];
    if (args.skipExec || manifest.platform !== hostTarget) { verifyArgs.push('--skip-exec'); }
    const verify = spawnSync(process.execPath, verifyArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    process.stderr.write(verify.stderr ?? '');
    if (verify.status !== 0) {
      return fail({ ok: false, stage: 'post-install', error: 'candidate failed post-install verification', report: verify.stdout ?? '' }, 1);
    }

    // 2. Evidence must bind the candidate manifest and every artifact byte.
    const evidenceBytes = readFileSync(args.evidence);
    const evidence = JSON.parse(evidenceBytes.toString('utf8')) as PromotionEvidence;
    const problems = validatePromotionEvidence({ manifest, manifestSha256: candidateManifestSha256, evidence });
    if (problems.length > 0) {
      return fail({ ok: false, stage: 'evidence', problems }, 1);
    }

    // 2b. The explicit sanitized acceptance report files are the source of the
    //     installed/Gateway facts. Hash their raw bytes, bind them to the
    //     evidence, and re-check identity/lifecycle/live facts from the bytes.
    //     A missing or stale/fabricated file is rejected before any output.
    const readReport = (label: string, file: string): Buffer => {
      if (!existsSync(file)) {
        return fail({ ok: false, stage: 'acceptance-report', error: `${label} acceptance report not found: ${file}` }, 1);
      }
      return readFileSync(file);
    };
    const parseReport = (label: string, bytes: Buffer): unknown => {
      try {
        return JSON.parse(bytes.toString('utf8'));
      } catch {
        return fail({ ok: false, stage: 'acceptance-report', error: `${label} acceptance report is not valid JSON` }, 1);
      }
    };
    const installedReportBytes = readReport('installed', args.installedReport);
    const gatewayReportBytes = readReport('gateway', args.gatewayReport);
    const installedReportJson = parseReport('installed', installedReportBytes);
    const gatewayReportJson = parseReport('gateway', gatewayReportBytes);
    const reportProblems = validateAcceptanceReports({
      manifest,
      evidence,
      installedReport: installedReportJson,
      installedReportSha256: sha256Hex(installedReportBytes),
      gatewayReport: gatewayReportJson,
      gatewayReportSha256: sha256Hex(gatewayReportBytes),
    });
    if (reportProblems.length > 0) {
      return fail({ ok: false, stage: 'acceptance-report', problems: reportProblems }, 1);
    }
    const gatewayIdentity = (gatewayReportJson as {
      gatewayAcceptance?: { gateway?: { url?: string; serverIdentity?: string } };
    }).gatewayAcceptance?.gateway;

    // 3. Re-verify source material and the actual tested native receipt on disk.
    const app = requiredArtifact(manifest, 'sources/application-source.json');
    const appArchive = requiredArtifact(manifest, 'sources/application-source.tar.gz');
    const appKit = verifyApplicationSourceArchive(
      path.join(installDir, appArchive.path),
      readFileSync(path.join(installDir, app.path)),
    );
    if (appKit.target !== manifest.platform || appKit.source.commit !== manifest.sourceSHA ||
      appKit.source.dirtyTreeHash !== manifest.dirtyTreeHash) {
      return fail({ ok: false, stage: 'application-source', error: 'application source kit differs from candidate identity' }, 1);
    }

    const nativeIndex = requiredArtifact(manifest, 'sources/native-source.json');
    const nativeArchive = requiredArtifact(manifest, 'sources/native-source.tar.gz');
    const nativeReceipt = requiredArtifact(manifest, 'sources/native-source-build.json');
    const helper = requiredArtifact(manifest, 'helper/agentfs-pod');
    const nativeKit = verifyNativeSourceArchive(
      path.join(installDir, nativeArchive.path),
      readFileSync(path.join(installDir, nativeIndex.path)),
    );
    const receipt = JSON.parse(readFileSync(path.join(installDir, nativeReceipt.path), 'utf8')) as {
      testsPassed?: boolean; compiler?: PromotionEvidence['nativeTest']['compiler'];
    };
    if (receipt.testsPassed !== true) {
      return fail({ ok: false, stage: 'native-receipt', error: 'candidate native build receipt did not run/pass tests' }, 1);
    }
    try {
      validateNativeBuildReceipt(receipt, nativeKit, nativeIndex.sha256, helper.sha256, manifest.platform);
    } catch (error) {
      return fail({ ok: false, stage: 'native-receipt', error: (error as Error).message }, 1);
    }
    const proof = evidence.nativeTest.compiler;
    if (receipt.compiler?.toolchain !== proof.toolchain || receipt.compiler?.cargoSha256 !== proof.cargoSha256 ||
      receipt.compiler?.rustcSha256 !== proof.rustcSha256) {
      return fail({ ok: false, stage: 'native-receipt', error: 'evidence compiler identity differs from the candidate receipt' }, 1);
    }

    // 4. Derive the promoted manifest and compute readiness from the real gate.
    const promoted = derivePromotedManifest(manifest, evidence);
    const gate = publicGateProblems(promoted);
    if (gate.length > 0) {
      return fail({ ok: false, stage: 'public-gate', problems: gate }, 3);
    }

    // 5. Write a separate promoted install/archive. Never touch the candidate.
    mkdirSync(targetRoot, { recursive: true });
    const promotedInstall = path.join(targetRoot, 'install');
    cpSync(installDir, promotedInstall, { recursive: true });
    rmSync(path.join(promotedInstall, 'manifest.local.json'), { force: true });
    writeFileSync(path.join(promotedInstall, 'manifest.json'), JSON.stringify(promoted, null, 2) + '\n');
    const record = buildPromotionRecord({
      candidateManifestSha256,
      promotedManifest: promoted,
      evidence,
      evidenceSha256: sha256File(args.evidence),
      publicGateProblems: gate,
      ...(gatewayIdentity ? { gatewayIdentity } : {}),
    });
    writeFileSync(path.join(promotedInstall, 'promotion-record.json'), JSON.stringify(record, null, 2) + '\n');

    const archive = path.join(targetRoot, `xpod-cli-${promoted.version}-${promoted.platform}-promoted.tar.gz`);
    run('tar', [ '-czf', archive, '-C', targetRoot, 'install' ]);

    // 6. Re-run post-install verification including the public gate on the
    //    promoted output, so a promotion cannot claim readiness it lacks.
    const finalVerifyArgs = [ path.join(packageRoot, 'scripts/verify-install.ts'), '--dir', promotedInstall, '--public' ];
    if (args.skipExec || promoted.platform !== hostTarget) { finalVerifyArgs.push('--skip-exec'); }
    const finalVerify = spawnSync(process.execPath, finalVerifyArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (finalVerify.status !== 0) {
      rmSync(targetRoot, { recursive: true, force: true });
      return fail({ ok: false, stage: 'promoted-verification', error: 'promoted output failed public verification', report: finalVerify.stdout ?? '' }, 1);
    }

    const summary = {
      ok: true,
      target: promoted.platform,
      version: promoted.version,
      promotedInstall,
      archive,
      archiveSha256: sha256File(archive),
      candidateManifestSha256,
      promotedManifestSha256: record.promotedManifestSha256,
      sourceSHA: promoted.sourceSHA,
      publicReleaseReady: true,
      publicGateProblems: gate,
      promotionRecord: path.join(promotedInstall, 'promotion-record.json'),
    };
    mkdirSync(targetRoot, { recursive: true });
    writeFileSync(path.join(targetRoot, 'promotion-summary.json'), JSON.stringify(summary, null, 2) + '\n');
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    if (temporary) { rmSync(temporary, { recursive: true, force: true }); }
  }
}

main();
