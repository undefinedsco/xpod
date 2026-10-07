import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts/verify-rc-cluster-target.cjs');
const dataRoot = path.join(repoRoot, '.test-data', 'rc-cluster-target');
const binDir = path.join(dataRoot, 'bin');

const GZ_SERVER = 'https://gzg.sealos.run:6443';
const SG_SERVER = 'https://cloud.sealos.io:6443';
const GZ_NAMESPACE = 'ns-iknkxtc8';
const SG_NAMESPACE = 'ns-1yl0rye9';
const SECRET_TOKEN = 'super-secret-kube-token';
const SECRET_USERINFO = 'user:pass';

// The guard must never shell out to a network client or depend on a live
// cluster: tests provide a fake `kubectl` on PATH that only echoes fixtures.
const FAKE_KUBECTL = `#!/bin/sh
if [ -n "$FAKE_KUBECTL_LOG" ]; then printf '%s\\n' "$*" >> "$FAKE_KUBECTL_LOG"; fi
if [ -n "$FAKE_KUBECTL_STDERR" ]; then printf '%s\\n' "$FAKE_KUBECTL_STDERR" >&2; fi
if [ "$FAKE_KUBECTL_FAIL" = "1" ]; then exit 1; fi
if [ -n "$FAKE_KUBECTL_JSON_FILE" ]; then cat "$FAKE_KUBECTL_JSON_FILE"; fi
exit 0
`;

interface KubeContextEntry {
  name: string;
  context: { cluster: string; namespace?: string; user?: string };
}

interface KubeClusterEntry {
  name: string;
  cluster: { server: string };
}

interface KubeFixture {
  kind: string;
  apiVersion: string;
  'current-context'?: string;
  contexts: KubeContextEntry[];
  clusters: KubeClusterEntry[];
  users: Array<{ name: string; user: Record<string, unknown> }>;
}

interface KubeFixtureOptions {
  contextName?: string;
  clusterRef?: string;
  clusterName?: string;
  includeContext?: boolean;
  includeCluster?: boolean;
}

function kubeconfig(server: string, namespace: string, options: KubeFixtureOptions = {}): KubeFixture {
  const contextName = options.contextName ?? 'selected';
  const clusterRef = options.clusterRef ?? 'selected-cluster';
  const clusterName = options.clusterName ?? clusterRef;
  const includeContext = options.includeContext ?? true;
  const includeCluster = options.includeCluster ?? true;
  return {
    kind: 'Config',
    apiVersion: 'v1',
    'current-context': contextName,
    contexts: includeContext
      ? [{ name: contextName, context: { cluster: clusterRef, namespace, user: 'selected-user' } }]
      : [],
    clusters: includeCluster ? [{ name: clusterName, cluster: { server } }] : [],
    users: [{ name: 'selected-user', user: { token: SECRET_TOKEN } }],
  };
}

interface GuardOptions {
  kubeconfig?: KubeFixture;
  raw?: string;
  namespace?: string;
  fail?: boolean;
  stderr?: string;
}

interface GuardResult {
  status: number;
  stdout: string;
  stderr: string;
  calls: string;
  dir: string;
}

async function runGuard(options: GuardOptions): Promise<GuardResult> {
  const dir = await mkdtemp(path.join(dataRoot, 'case-'));
  const jsonFile = path.join(dir, 'kubeconfig.json');
  const logFile = path.join(dir, 'kubectl.log');
  await writeFile(jsonFile, options.raw ?? JSON.stringify(options.kubeconfig ?? {}));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    FAKE_KUBECTL_JSON_FILE: jsonFile,
    FAKE_KUBECTL_LOG: logFile,
  };
  if (options.fail) env.FAKE_KUBECTL_FAIL = '1';
  if (options.stderr) env.FAKE_KUBECTL_STDERR = options.stderr;
  if (options.namespace === undefined) delete env.SEALOS_NAMESPACE;
  else env.SEALOS_NAMESPACE = options.namespace;
  try {
    const stdout = execFileSync(process.execPath, [ scriptPath ], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      stdio: [ 'ignore', 'pipe', 'pipe' ],
    });
    return { status: 0, stdout, stderr: '', calls: await readFile(logFile, 'utf8').catch(() => ''), dir };
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string };
    return {
      status: typeof failure.status === 'number' ? failure.status : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      calls: await readFile(logFile, 'utf8').catch(() => ''),
      dir,
    };
  }
}

function outputOf(result: GuardResult): string {
  return `${result.stdout}${result.stderr}`;
}

beforeAll(async () => {
  await rm(dataRoot, { recursive: true, force: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(binDir, 'kubectl'), FAKE_KUBECTL, { mode: 0o755 });
});

afterAll(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe('RC cluster target guard', () => {
  it('accepts the Guangzhou cluster through the current-context selection', async () => {
    const result = await runGuard({ kubeconfig: kubeconfig(GZ_SERVER, GZ_NAMESPACE), namespace: GZ_NAMESPACE });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Guangzhou');
    expect(result.calls).toContain('config view --minify --output=json');
  });

  it('validates only the selected current-context and ignores other clusters', async () => {
    const config = kubeconfig(GZ_SERVER, GZ_NAMESPACE);
    config.contexts.push({ name: 'sg', context: { cluster: 'sg-cluster', namespace: SG_NAMESPACE, user: 'sg-user' } });
    config.clusters.push({ name: 'sg-cluster', cluster: { server: SG_SERVER } });

    const result = await runGuard({ kubeconfig: config, namespace: GZ_NAMESPACE });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Guangzhou');
  });

  it.each([
    [ 'the Singapore cluster', SG_SERVER ],
    [ 'an unrelated host', 'https://gzg.sealos.run.evil.example:6443' ],
    [ 'a userinfo URL', `https://${SECRET_USERINFO}@gzg.sealos.run:6443` ],
    [ 'a query string', 'https://gzg.sealos.run:6443/?tenant=sg' ],
    [ 'a fragment', 'https://gzg.sealos.run:6443/#fragment' ],
    [ 'an extra path', 'https://gzg.sealos.run:6443/api' ],
    [ 'a trailing slash', 'https://gzg.sealos.run:6443/' ],
    [ 'a plaintext scheme', 'http://gzg.sealos.run:6443' ],
  ])('rejects %s without echoing the endpoint', async (_label, server) => {
    const result = await runGuard({ kubeconfig: kubeconfig(server, GZ_NAMESPACE), namespace: GZ_NAMESPACE });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('RC cluster target check failed');
    expect(result.stderr).toContain('Guangzhou API endpoint');
    expect(outputOf(result)).not.toContain(server);
    expect(outputOf(result)).not.toContain(SECRET_USERINFO);
  });

  it('rejects a namespace that does not match SEALOS_NAMESPACE', async () => {
    const result = await runGuard({ kubeconfig: kubeconfig(GZ_SERVER, SG_NAMESPACE), namespace: GZ_NAMESPACE });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('RC cluster target check failed');
    expect(result.stderr).toContain('does not match SEALOS_NAMESPACE');
    expect(outputOf(result)).not.toContain(SG_NAMESPACE);
  });

  it('rejects an invalid namespace instead of accepting it', async () => {
    const result = await runGuard({ kubeconfig: kubeconfig(GZ_SERVER, 'Bad_Name'), namespace: 'Bad_Name' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('valid Kubernetes name');
  });

  it('requires SEALOS_NAMESPACE before validating any target', async () => {
    const result = await runGuard({ kubeconfig: kubeconfig(GZ_SERVER, GZ_NAMESPACE), namespace: undefined });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SEALOS_NAMESPACE is required');
  });

  it('fails closed on malformed kubectl JSON', async () => {
    const result = await runGuard({ raw: '{ this is not valid json', namespace: GZ_NAMESPACE });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('RC cluster target check failed');
    expect(result.stderr).toContain('invalid JSON');
  });

  it('fails closed when current-context is missing', async () => {
    const result = await runGuard({
      kubeconfig: { kind: 'Config', apiVersion: 'v1', contexts: [], clusters: [], users: [] },
      namespace: GZ_NAMESPACE,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('no current-context');
  });

  it('fails closed when the current-context entry is missing', async () => {
    const result = await runGuard({
      kubeconfig: kubeconfig(GZ_SERVER, GZ_NAMESPACE, { includeContext: false }),
      namespace: GZ_NAMESPACE,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('incomplete');
  });

  it('fails closed when the referenced cluster entry is missing', async () => {
    const result = await runGuard({
      kubeconfig: kubeconfig(GZ_SERVER, GZ_NAMESPACE, { includeCluster: false }),
      namespace: GZ_NAMESPACE,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('incomplete');
  });

  it('fails closed and never echoes child process output when kubectl fails', async () => {
    const result = await runGuard({
      kubeconfig: kubeconfig(GZ_SERVER, GZ_NAMESPACE),
      namespace: GZ_NAMESPACE,
      fail: true,
      stderr: SECRET_TOKEN,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('kubectl config view failed');
    expect(outputOf(result)).not.toContain(SECRET_TOKEN);
    expect(outputOf(result)).not.toContain('spawn');
  });

  it('verifies the selected context without printing kubeconfig material', async () => {
    const result = await runGuard({ kubeconfig: kubeconfig(GZ_SERVER, GZ_NAMESPACE), namespace: GZ_NAMESPACE });

    expect(result.status).toBe(0);
    for (const marker of [ SECRET_TOKEN, GZ_SERVER, 'selected-cluster', 'selected-user' ]) {
      expect(outputOf(result)).not.toContain(marker);
    }
  });
});
