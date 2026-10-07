import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const workflow = parse(readFileSync(path.resolve('.github/workflows/solidfs-gz-readonly.yml'), 'utf8'));
const script: string = workflow.jobs.observe.steps[0].run;
const namespace = 'ns-iknkxtc8';
const fixture = { items: [{ kind: 'Deployment', metadata: { name: 'xpod-rc', namespace, uid: 'owned-uid', resourceVersion: '1' },
  spec: { replicas: 1, template: { spec: { containers: [{ name: 'xpod', image: 'example@sha256:abc',
    env: [{ name: 'PRIVATE', value: 'do-not-collect' }] }] } } },
  data: { password: 'do-not-collect' } }] };

function observe(server: string): { status: number | null; calls: string[]; report?: string; files: string[] } {
  const parent = path.resolve('.test-data/gz-readonly-workflow');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'owned-'));
  const calls = path.join(directory, 'calls');
  try {
    const result = spawnSync('bash', ['-c', `kubectl() {
      printf '%s\\n' "$*" >> "$CALLS"
      if [ "$1" = config ]; then printf '%s' "$SERVER"; else printf '%s' "$FIXTURE"; fi
    }
    ${script}`], { encoding: 'utf8', timeout: 5000, env: {
      PATH: process.env.PATH, RUNNER_TEMP: directory, GITHUB_SHA: 'source-sha', CALLS: calls,
      SERVER: server, FIXTURE: JSON.stringify(fixture), KUBE_CONFIG_DATA: Buffer.from('fake-config').toString('base64'),
    } });
    const files = readdirSync(directory);
    return { status: result.status, files, calls: readFileSync(calls, 'utf8').trim().split('\n'),
      report: files.includes('gz-readonly-evidence') ? readFileSync(path.join(directory, 'gz-readonly-evidence/facts.json'), 'utf8') : undefined };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe('GZ read-only workflow boundary (offline)', () => {
  it('refuses another server before querying resources and removes its kubeconfig', () => {
    const result = observe('https://wrong.example:6443');
    expect(result.status).not.toBe(0);
    expect(result.calls).toHaveLength(1);
    expect(result.report).toBeUndefined();
    expect(result.files.some((name) => name.startsWith('gz-readonly.'))).toBe(false);
  });
  it('queries only admitted namespace metadata and excludes environment and Secret payloads', () => {
    const result = observe('https://gzg.sealos.run:6443');
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(['config view --minify -o jsonpath={.clusters[0].cluster.server}',
      '--request-timeout=30s -n ns-iknkxtc8 get deployment,statefulset,service,ingress -o json']);
    expect(result.report).not.toContain('do-not-collect');
    expect(JSON.parse(result.report!).resources[0].images).toEqual([{ name: 'xpod', image: 'example@sha256:abc' }]);
    expect(JSON.parse(result.report!).evidenceLevel).toBe('READ-ONLY-METADATA');
    expect(result.files.some((name) => name.startsWith('gz-readonly.'))).toBe(false);
  });
});
