import { describe, expect, it, vi } from 'vitest';
import { PodSolidFsHttpClient } from '@undefineds.co/xpod-afs/workcopy/PodSolidFsHttpClient';
import { getSqliteRuntime as canonicalRuntime } from '@undefineds.co/xpod-afs/sqlite/SqliteRuntime';
import { getSqliteRuntime as serverRuntime } from '../../src/storage/SqliteRuntime';

describe('standalone workcopy boundary', () => {
  it('shares the same canonical runtime with server consumers', () => {
    expect(canonicalRuntime()).toBe(serverRuntime());
  });

  it('forwards opaque host context and returns a rejected response without replay', async () => {
    const response = new Response(null, { status: 401 });
    const request = vi.fn(async (_url: string, _init: RequestInit, _context?: unknown) => response);
    const client = new PodSolidFsHttpClient({ request });
    const context = { hostOwned: Symbol('context') };
    const init = { method: 'PUT' };
    expect(await client.request('https://pod.example/resource', init, context)).toBe(response);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('https://pod.example/resource', init, context);
  });

  it('accepts an existing two-argument authenticated request without owning credentials', async () => {
    const response = new Response(null, { status: 204 });
    const request = async (_url: string, _init: RequestInit): Promise<Response> => response;
    expect(await new PodSolidFsHttpClient({ request }).request('https://pod.example/resource', {})).toBe(response);
  });
});
