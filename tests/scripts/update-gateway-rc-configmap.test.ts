import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts/update-gateway-rc-configmap.cjs');
const tempRoots: string[] = [];
const configKey = 'vn-etcvn-nginxvn-confvn-dvn-defaultvn-conf';

const existingNginx = `map $http_upgrade $connection_upgrade {
  default upgrade;
  '' close;
}

server {
  listen 8082;
  server_name id.undefineds.co;
  location / { proxy_pass http://xpod.example.svc.cluster.local:80; }
}
`;

async function run(input: unknown, namespace = 'ns-rc'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-gateway-rc-'));
  tempRoots.push(root);
  const inputPath = path.join(root, 'gateway.yaml');
  await writeFile(inputPath, JSON.stringify(input));
  const { stdout } = await execFile('node', [scriptPath, '--input', inputPath, '--namespace', namespace], {
    cwd: repoRoot,
  });
  return stdout;
}

function configMap(value = existingNginx): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: 'gateway',
      namespace: 'old-namespace',
      labels: { existing: 'preserved' },
      resourceVersion: '123',
      uid: 'do-not-apply',
    },
    data: {
      untouched: 'keep-me',
      [configKey]: value,
    },
  };
}

describe('RC gateway ConfigMap updater', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('preserves the ConfigMap and adds the three RC routes inside a managed marker', async () => {
    const output = await run(configMap(), 'ns-1yl0rye9');
    const manifest = parse(output);
    const nginx = manifest.data[configKey] as string;

    expect(manifest).toMatchObject({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: 'gateway',
        namespace: 'old-namespace',
        labels: { existing: 'preserved' },
      },
      data: { untouched: 'keep-me' },
    });
    expect(manifest.metadata).not.toHaveProperty('resourceVersion');
    expect(manifest.metadata).not.toHaveProperty('uid');
    expect(nginx).toContain('server_name id.undefineds.co;');
    expect(nginx).toContain('# BEGIN XPOD RC ROUTES');
    expect(nginx).toContain('# END XPOD RC ROUTES');
    expect(nginx).toContain('listen 8082;\n  server_name id-rc.undefineds.co;');
    expect(nginx).toContain('listen 8083;\n  server_name pods-rc.undefineds.co;');
    expect(nginx).toContain('listen 8081;\n  server_name api-rc.undefineds.co;');
    expect(nginx.match(/proxy_pass http:\/\/xpod-rc\.ns-1yl0rye9\.svc\.cluster\.local:80;/g)).toHaveLength(3);
  });

  it('updates its managed block idempotently without duplicating routes', async () => {
    const first = parse(await run(configMap(), 'first-ns'));
    const second = parse(await run(first, 'second-ns'));
    const nginx = second.data[configKey] as string;

    expect(nginx.match(/# BEGIN XPOD RC ROUTES/g)).toHaveLength(1);
    expect(nginx.match(/server_name id-rc\.undefineds\.co;/g)).toHaveLength(1);
    expect(nginx.match(/server_name pods-rc\.undefineds\.co;/g)).toHaveLength(1);
    expect(nginx.match(/server_name api-rc\.undefineds\.co;/g)).toHaveLength(1);
    expect(nginx).not.toContain('xpod-rc.first-ns.svc.cluster.local');
    expect(nginx.match(/xpod-rc\.second-ns\.svc\.cluster\.local/g)).toHaveLength(3);
  });

  it('rejects Secret input without printing its contents', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-gateway-secret-'));
    tempRoots.push(root);
    const inputPath = path.join(root, 'secret.yaml');
    await writeFile(inputPath, JSON.stringify({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'gateway' },
      stringData: { password: 'super-sensitive-value' },
    }));

    await expect(execFile('node', [scriptPath, '--input', inputPath, '--namespace', 'ns-rc'], {
      cwd: repoRoot,
    })).rejects.toMatchObject({
      stderr: expect.not.stringContaining('super-sensitive-value'),
    });
  });
});
