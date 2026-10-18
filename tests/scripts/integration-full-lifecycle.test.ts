import { afterEach, describe, expect, it, vi } from 'vitest';

const { startRuntime } = vi.hoisted(() => ({ startRuntime: vi.fn() }));
vi.mock('../../src/runtime/XpodRuntime', () => ({ startXpodRuntime: startRuntime }));
import { startFullRuntimes } from '../../scripts/run-integration-full';

const ports = {
  cloud: { gateway: 6300, css: 6310, api: 6311, ingress: 6303 },
  cloudB: { gateway: 6400, css: 6410, api: 6411, ingress: 6403 },
  local: { gateway: 5737, css: 5747, api: 5748, ingress: 5740 },
  standalone: { gateway: 5739, css: 5749, api: 5750, ingress: 5742 },
};

describe('full integration startup cleanup', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); startRuntime.mockReset(); });

  it('declares each fixture issuer instead of inheriting a developer account authority', async () => {
    vi.stubEnv('SOLID_OIDC_ISSUER', 'https://foreign-issuer.example.test/');
    startRuntime.mockResolvedValue({ stop: vi.fn(async () => {}) });

    await startFullRuntimes(ports, 'fixture-command');

    const plans = startRuntime.mock.calls.map(([plan]) => plan);
    for (const plan of [plans[0], plans[1], plans[3]]) {
      expect(plan.env.SOLID_OIDC_ISSUER).toBe(plan.baseUrl);
    }
    expect(plans[2].env.SOLID_OIDC_ISSUER).toBe(plans[0].baseUrl);
    expect(plans[2].env.SOLID_OIDC_ISSUER).not.toBe(plans[2].baseUrl);
    expect(process.env.SOLID_OIDC_ISSUER).toBe('https://foreign-issuer.example.test/');
  });

  it('keeps Local fixtures off ambient Redis while Cloud uses the owned fixture Redis', async () => {
    vi.stubEnv('CSS_REDIS_CLIENT', 'redis://foreign-redis.example.test:6379');
    vi.stubEnv('CSS_REDIS_USERNAME', 'foreign-user');
    vi.stubEnv('CSS_REDIS_PASSWORD', 'fixture-foreign-password');
    vi.stubEnv('REDIS_URL', 'redis://fallback-redis.example.test:6379');
    startRuntime.mockResolvedValue({ stop: vi.fn(async () => {}) });

    await startFullRuntimes(ports, 'fixture-command', { postgres: 5432, redis: 16379, minio: 19000 });

    const plans = startRuntime.mock.calls.map(([plan]) => plan);
    for (const plan of plans.slice(0, 2)) {
      expect(plan.env).toMatchObject({ CSS_REDIS_CLIENT: 'localhost:16379', CSS_REDIS_USERNAME: '', CSS_REDIS_PASSWORD: '' });
    }
    // An explicit empty canonical key also blocks REDIS_URL fallback in API config.
    for (const plan of plans.slice(2)) {
      expect(plan.env).toMatchObject({ CSS_REDIS_CLIENT: '', CSS_REDIS_USERNAME: '', CSS_REDIS_PASSWORD: '' });
    }
    expect(process.env.CSS_REDIS_CLIENT).toBe('redis://foreign-redis.example.test:6379');
  });

  it.each([false, true])('reports the startup error before stopping partial runtimes (stop fails=%s)', async stopFails => {
    const order: string[] = [];
    const original = new Error('second node startup failed');
    const stop = vi.fn(async () => { order.push('stop'); if (stopFails) throw new Error('stop failed'); });
    const log = vi.spyOn(console, 'error').mockImplementation(() => { order.push('error'); });
    startRuntime.mockResolvedValueOnce({ stop }).mockRejectedValueOnce(original);

    await expect(startFullRuntimes(ports, 'fixture-command')).rejects.toBe(original);
    expect(stop).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('[full] Runtime startup failed:', original);
    expect(order).toEqual(['error', 'stop']);
  });

  it('hands successful runtimes to the caller without stopping them', async () => {
    const stop = vi.fn(async () => {});
    startRuntime.mockResolvedValue({ stop });
    const runtimes = await startFullRuntimes(ports, 'fixture-command');
    expect(runtimes).toHaveLength(4);
    for (const [index, plan] of Object.values(ports).entries()) {
      expect(startRuntime.mock.calls[index][0]).toMatchObject({
        gatewayPort: plan.gateway, cssPort: plan.css, apiPort: plan.api, ingressPort: plan.ingress,
      });
    }
    expect(stop).not.toHaveBeenCalled();
  });
});
