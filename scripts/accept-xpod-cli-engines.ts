#!/usr/bin/env bun
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startPodContractServer } from '../tests/agentfs-pod/support/podContractServer';
import { discoverAgentFsHelper } from '../tests/agentfs-pod/support/helperDiscovery';
import { runMountAcceptance } from '../tests/agentfs-pod/support/mountHarness';
import { probeRustBackend } from '../tests/agentfs-pod/support/rustBackendHarness';
import { ADMISSION_SCENARIOS, evaluateAdmission } from '../tests/xpod-cli-engines/admissionScenarios';

const EXIT = { ok: 0, fail: 1, unavailable: 3 };
const WORK_ROOT = path.resolve('.test-data/agent-directory-workers/agentfs-test/engines');
const TOKEN = 'engines-token';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function writeReport(engine: string, payload: unknown): void {
  mkdirSync(WORK_ROOT, { recursive: true });
  const file = path.join(WORK_ROOT, `${engine}-report.json`);
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[engines] wrote ${file}`);
}

async function main(): Promise<void> {
  const engine = arg('engine', 'agentfs');
  console.log(`[engines] engine=${engine} platform=${process.platform}/${os.arch()} scenarios=${ADMISSION_SCENARIOS.length}`);

  if (engine === 'rclone') {
    const candidates = [
      process.env.XPOD_RCLONE_POD_CMD,
      path.join(process.cwd(), 'tools', 'rclone-pod', 'target', 'release', 'rclone-pod'),
      path.join(process.cwd(), 'tools', 'rclone-pod', 'rclone-pod'),
    ].filter((entry): entry is string => Boolean(entry));
    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) {
      console.log('STATUS: UNAVAILABLE - rclone-pod tool not built (owned by a separate implementation worker); no admission run.');
      writeReport(engine, { status: 'unavailable', engine, candidates });
      process.exit(EXIT.unavailable);
    }
    console.log(`[engines] rclone tool found at ${found}; admission execution is pending its interface`);
    writeReport(engine, { status: 'unavailable', engine, found, reason: 'rclone admission runner not yet wired to its interface' });
    process.exit(EXIT.unavailable);
  }

  const helper = discoverAgentFsHelper();
  if (!helper.helperPath) {
    console.log(`STATUS: UNAVAILABLE - AgentFS helper not built: ${helper.reason}`);
    writeReport(engine, { status: 'unavailable', engine, reason: helper.reason });
    process.exit(EXIT.unavailable);
  }

  mkdirSync(WORK_ROOT, { recursive: true });
  const server = await startPodContractServer({
    token: TOKEN,
    files: { 'alpha.txt': 'ALPHA_BODY_0123456789\n', 'big.txt': `${'x'.repeat(200_000)}\nBIG_END\n` },
  });
  try {
    const backend = await probeRustBackend(helper, server, TOKEN, path.join(WORK_ROOT, 'rust-backend'));
    const mount = await runMountAcceptance({ server, helper, token: TOKEN, workDir: path.join(WORK_ROOT, 'mount') });
    for (const check of mount.checks) {
      console.log(`[engines] agentfs ${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
    }
    for (const note of mount.notes) {
      console.log(`[engines] note: ${note}`);
    }
    // Only scenarios actually exercised by this run are marked; everything else
    // stays not-run so the overall result is INCOMPLETE rather than a false PASS.
    const checkOk = (name: string): boolean => mount.checks.find((check) => check.name === name)?.ok === true;
    const scenarioStatus = (id: string): 'pass' | 'fail' | 'not-run' => {
      switch (id) {
        case 'metadata-zero-body':
          return checkOk('readdir-no-body') ? 'pass' : 'fail';
        case 'correct-range-206':
          return checkOk('seek-range-read') && checkOk('large-file-seek') ? 'pass' : 'fail';
        case 'external-mutation-visible':
          return checkOk('external-update-invalidation') ? 'pass' : 'fail';
        default:
          return 'not-run';
      }
    };
    const results = ADMISSION_SCENARIOS.map((scenario) => ({ id: scenario.id, status: scenarioStatus(scenario.id) }));
    const evaluation = evaluateAdmission(results);
    for (const scenario of ADMISSION_SCENARIOS) {
      const status = results.find((result) => result.id === scenario.id)?.status ?? 'not-run';
      console.log(`[engines] scenario ${status.toUpperCase()} ${scenario.id}`);
    }
    writeReport(engine, { status: evaluation.status, engine, backend, evaluation, checks: mount.checks, notes: mount.notes, benchmark: mount.benchmark });
    console.log(`STATUS: ${evaluation.status.toUpperCase()}${evaluation.status === 'incomplete' ? ` (not-run: ${evaluation.notRun.join(',')})` : ''}`);
    process.exit(evaluation.status === 'pass' ? EXIT.ok : evaluation.status === 'incomplete' ? EXIT.unavailable : EXIT.fail);
  } finally {
    await server.close();
    rmSync(path.join(WORK_ROOT, 'mount'), { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error('[engines] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(EXIT.fail);
});
