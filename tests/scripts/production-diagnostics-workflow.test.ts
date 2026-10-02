import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';

const workflowUrl = new URL('../../.github/workflows/diagnose-production.yml', import.meta.url);

async function loadWorkflow(): Promise<Record<string, any>> {
  const text = await readFile(workflowUrl, 'utf8');
  return parseDocument(text).toJSON() as Record<string, any>;
}

function allRunText(workflow: Record<string, any>): string {
  return Object.values(workflow.jobs ?? {})
    .flatMap((job: any) => (job.steps ?? []).map((step: any) => step.run))
    .filter((run: unknown): run is string => typeof run === 'string')
    .join('\n');
}

function probeStep(workflow: Record<string, any>): any {
  const step = workflow.jobs.diagnose.steps.find((entry: any) => entry.name === 'Probe RC registry credentials');
  expect(step).toBeDefined();
  return step;
}

function extractProbeParser(run: string): string {
  const marker = "read -r -d '' tcr_probe_parser <<'NODE'";
  const start = run.indexOf('\n', run.indexOf(marker)) + 1;
  const end = run.indexOf('\nNODE', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return run.slice(start, end);
}

function runProbe(parser: string, stdin: string) {
  return spawnSync('node', [ '-e', parser ], { encoding: 'utf8', input: stdin });
}

describe('production diagnostics workflow', () => {
  it('captures pod state and previous container logs without mutating the cluster', async () => {
    const workflow = await loadWorkflow();
    const text = allRunText(workflow);

    expect(text).toContain('kubectl -n "$SEALOS_NAMESPACE" get deploy,rs,pods -o wide');
    expect(text).toContain('--previous');
    expect(text).not.toContain('kubectl apply');
  });

  it('exposes the registry probe only as an optional rc-only read of tcr-creds', async () => {
    const workflow = await loadWorkflow();

    expect(workflow.on.workflow_dispatch.inputs.registry_probe).toMatchObject({ type: 'boolean', default: false });
    const step = probeStep(workflow);
    expect(step.if).toBe("inputs.environment == 'rc' && inputs.registry_probe");
    expect(step.run).toContain('get secret tcr-creds');
    // The probe reads exactly one named secret field; no mutation verbs or
    // broader Secret enumeration.
    expect(step.run).not.toContain('kubectl apply');
    expect(step.run).not.toContain('rollout restart');
    expect(step.run).not.toContain('get secrets ');
    expect(step.run).not.toContain('delete ');
    expect(step.run).toContain("-o jsonpath='{.data.\\.dockerconfigjson}'");
  });

  it('reports only bounded booleans and counts for a valid TCR docker config', async () => {
    const parser = extractProbeParser(probeStep(await loadWorkflow()).run);
    const sentinel = 'FAKE_TEST_SENTINEL_should_never_appear';
    const config = {
      auths: {
        'ccr.ccs.tencentyun.com': { username: sentinel, password: `${sentinel}-pw` },
      },
    };
    const result = runProbe(parser, Buffer.from(JSON.stringify(config), 'utf8').toString('base64'));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain(sentinel);
    const summary = JSON.parse(result.stdout.trim());
    expect(summary).toEqual({
      fieldNonempty: true,
      decodeStatus: 'ok',
      parseStatus: 'ok',
      authsIsObject: true,
      authorityMatchCount: 1,
      selectedEntryIsObject: true,
      selectedAuthPresent: false,
      selectedUsernamePresent: true,
      selectedPasswordPresent: true,
      selectedIdentityTokenPresent: false,
    });
  });

  it('counts only the expected authority and never echoes other registry keys', async () => {
    const parser = extractProbeParser(probeStep(await loadWorkflow()).run);
    const sentinel = 'FAKE_TEST_SENTINEL_should_never_appear';
    const config = {
      auths: {
        'docker.io': { auth: sentinel },
        'quay.io': { auth: sentinel },
        'https://ccr.ccs.tencentyun.com': { auth: 'tcr-token' },
      },
    };
    const result = runProbe(parser, Buffer.from(JSON.stringify(config), 'utf8').toString('base64'));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(sentinel);
    expect(result.stdout).not.toContain('docker.io');
    expect(result.stdout).not.toContain('quay.io');
    const summary = JSON.parse(result.stdout.trim());
    expect(summary.authorityMatchCount).toBe(1);
    expect(summary.selectedAuthPresent).toBe(true);
  });

  it('fails closed on an empty field and on malformed input without leaking bytes', async () => {
    const parser = extractProbeParser(probeStep(await loadWorkflow()).run);

    const empty = runProbe(parser, '');
    expect(empty.status, empty.stderr).not.toBe(0);
    expect(JSON.parse(empty.stdout.trim()).fieldNonempty).toBe(false);

    const sentinel = 'FAKE_TEST_SENTINEL_should_never_appear';
    const malformed = runProbe(
      parser,
      Buffer.from(`{"auths":{"ccr.ccs.tencentyun.com":{"auth":${sentinel}}}}`, 'utf8').toString('base64'),
    );
    expect(malformed.status, malformed.stderr).not.toBe(0);
    expect(malformed.stdout).toContain('parseStatus');
    expect(malformed.stdout).not.toContain(sentinel);
    expect(malformed.stdout).not.toContain('SyntaxError');
    expect(malformed.stdout).not.toContain('Unexpected');
  });

  it('separates fetch failure from parse failure in the workflow shell', async () => {
    const run = probeStep(await loadWorkflow()).run;

    expect(run).toContain('could not fetch the tcr-creds secret field');
    expect(run).toContain('could not parse the tcr-creds secret field');
    expect(run).toContain('probe_statuses=("${PIPESTATUS[@]}")');
  });
});
