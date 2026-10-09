#!/usr/bin/env bun
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startPodContractServer } from '../tests/agentfs-pod/support/podContractServer';
import { discoverAgentFsHelper } from '../tests/agentfs-pod/support/helperDiscovery';
import { runMountAcceptance } from '../tests/agentfs-pod/support/mountHarness';
import { probeRustBackend, RUST_BACKEND_CLI } from '../tests/agentfs-pod/support/rustBackendHarness';

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_UNAVAILABLE = 3;

const WORK_ROOT = path.resolve('.test-data/agent-directory-workers/agentfs-test');
const REPORT_JSON = path.join(WORK_ROOT, 'accept-report.json');
const TOKEN = 'accept-token';

async function main(): Promise<void> {
  const helper = discoverAgentFsHelper();
  const environment = {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
  };
  console.log(`[agentfs] platform=${environment.platform} release=${environment.release} arch=${environment.arch}`);
  console.log(`[agentfs] helper.available=${helper.available} source=${helper.source ?? '-'} reason=${helper.reason}`);
  console.log(`[agentfs] helperPath=${helper.helperPath ?? '(not built)'} checkBinary=${helper.checkBinaryPath ?? '(not built)'} fuse=${helper.fuseAvailable} nfs=${helper.nfsMountAvailable}`);

  if (!helper.helperPath) {
    console.log('STATUS: UNAVAILABLE - neither the Rust backend probe nor an OS mount could be executed; no mock mount was substituted.');
    for (const requirement of helper.platformRequirements) {
      console.log(`  requirement: ${requirement}`);
    }
    for (const entry of RUST_BACKEND_CLI) {
      console.log(`  backend-contract: ${entry}`);
    }
    writeReport({
      status: 'unavailable',
      environment,
      helper: { source: helper.source, command: helper.command, reason: helper.reason },
      platformRequirements: helper.platformRequirements,
      backendContract: RUST_BACKEND_CLI,
      checks: [],
      benchmark: [],
    });
    process.exit(EXIT_UNAVAILABLE);
  }

  const workDir = path.join(WORK_ROOT, 'mount');
  mkdirSync(workDir, { recursive: true });
  const server = await startPodContractServer({
    token: TOKEN,
    files: {
      'alpha.txt': 'ALPHA_BODY_0123456789\n',
      'big.txt': `${'x'.repeat(200_000)}\nBIG_END\n`,
    },
  });

  try {
    console.log(`[agentfs] starting Pod contract server at ${server.podRoot}`);
    const backend = await probeRustBackend(helper, server, TOKEN, path.join(WORK_ROOT, 'rust-backend'));
    console.log(`[agentfs] rust-backend status=${backend.status}`);
    for (const check of backend.checks) {
      console.log(`[agentfs] rust-backend ${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
    }

    if (helper.available) {
      const mountReport = await runMountAcceptance({ server, helper, token: TOKEN, workDir });
      for (const check of mountReport.checks) {
        console.log(`[agentfs] mount ${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
      }
      for (const sample of mountReport.benchmark) {
        console.log(`[agentfs] benchmark ${sample.scenario}/${sample.target} median=${sample.medianMs.toFixed(3)}ms`);
      }
      for (const note of mountReport.notes) {
        console.log(`[agentfs] note: ${note}`);
      }
      for (const entry of server.history) {
        console.log(`[agentfs] http ${JSON.stringify(entry)}`);
      }
      writeReport({ status: mountReport.status, backend, environment, helper: { source: helper.source, command: helper.command }, platformRequirements: mountReport.platformRequirements, checks: mountReport.checks, benchmark: mountReport.benchmark, notes: mountReport.notes });
      if (mountReport.status === 'unavailable') {
        console.log('STATUS: UNAVAILABLE - the helper did not perform a real OS mount; no mock mount was substituted.');
        for (const requirement of mountReport.platformRequirements) {
          console.log(`  requirement: ${requirement}`);
        }
        process.exit(backend.status === 'pass' ? EXIT_UNAVAILABLE : EXIT_FAIL);
      }
      console.log(`STATUS: ${mountReport.status.toUpperCase()}`);
      process.exit(mountReport.status === 'pass' ? EXIT_OK : EXIT_FAIL);
    }

    writeReport({ status: backend.status === 'pass' ? 'backend-only-pass' : 'fail', backend, environment, helper: { source: helper.source, command: helper.command }, platformRequirements: helper.platformRequirements, checks: backend.checks, benchmark: [], notes: backend.notes });
    if (backend.status === 'pass') {
      console.log('STATUS: BACKEND-ONLY PASS - Rust FileSystem/File backend verified over Pod HTTP; OS mount still UNAVAILABLE on this host.');
      for (const requirement of helper.platformRequirements) {
        console.log(`  mount-requirement: ${requirement}`);
      }
      process.exit(EXIT_UNAVAILABLE);
    }
    console.log('STATUS: FAIL - Rust backend probe failed.');
    process.exit(EXIT_FAIL);
  } finally {
    await server.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

function writeReport(payload: unknown): void {
  mkdirSync(WORK_ROOT, { recursive: true });
  writeFileSync(REPORT_JSON, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[agentfs] wrote ${REPORT_JSON}`);
}

main().catch((error: unknown) => {
  console.error('[agentfs] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAIL);
});
