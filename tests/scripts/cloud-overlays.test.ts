import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const overlayRoot = path.join(repoRoot, 'deploy/sealos/cloud/overlays');

interface Case { env: 'cn' | 'co'; deployment: string; secret: string }

const cases: Case[] = [
  { env: 'cn', deployment: 'xpod-cn', secret: 'xpod-cloud-secret' },
  { env: 'co', deployment: 'xpod-co', secret: 'xpod-co-secret' },
];

function read(env: string, file: string): any {
  return parse(readFileSync(path.join(overlayRoot, env, file), 'utf8'));
}

describe.each(cases)('$env environment overlay', ({ env, deployment, secret }) => {
  it('describes the deployment and service that environment runs', () => {
    const kustomization = read(env, 'kustomization.yaml');
    const deploy = read(env, 'deployment.yaml');
    const service = read(env, 'service.yaml');

    expect(kustomization.namespace).toBe('ns-iknkxtc8');
    expect(deploy.metadata.name).toBe(deployment);
    expect(deploy.metadata.namespace).toBe('ns-iknkxtc8');
    // 模板标签可以比 selector 多（cn 就多一个 part-of 标签），但必须覆盖 selector。
    expect(deploy.spec.template.metadata.labels).toMatchObject(deploy.spec.selector.matchLabels);
    expect(service.spec.selector).toEqual(deploy.spec.selector.matchLabels);
  });

  it('mounts the enterprise config the image needs to start', () => {
    // Without this mount the container exits with "Config file not found:
    // /app/config/cloud.enterprise.json", which is how co crash-looped.
    const container = read(env, 'deployment.yaml').spec.template.spec.containers[0];
    const mounts = (container.volumeMounts ?? []).map((mount: any) => mount.mountPath);

    expect(mounts).toContain('/app/config/cloud.enterprise.json');
  });

  it('reads its runtime configuration from its own secret', () => {
    const container = read(env, 'deployment.yaml').spec.template.spec.containers[0];
    const refs = (container.envFrom ?? []).map((entry: any) => Object.values(entry)[0] as any);

    expect(refs.map((ref: any) => ref.name)).toContain(secret);
  });

  it('pins the image by digest rather than a moving tag', () => {
    const image = read(env, 'deployment.yaml').spec.template.spec.containers[0].image as string;

    expect(image).toMatch(/@sha256:[a-f0-9]{64}$/);
  });
});
