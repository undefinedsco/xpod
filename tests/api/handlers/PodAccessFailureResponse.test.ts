import { describe, expect, it, vi } from 'vitest';

import {
  guardPodAccessRoute,
  podAccessFailureResponse,
} from '../../../src/api/handlers/PodAccessFailureResponse';
import { CALLER_OWNER_MISMATCH, CALLER_POD_ACCESS_UNAVAILABLE } from '../../../src/api/ai-gateway/auth/CallerPodAccess';
import { POD_INTERFACE_KEY_MISSING } from '../../../src/api/ai-gateway/pod/OwnerPodAccess';

describe('podAccessFailureResponse', () => {
  it.each([
    [ CALLER_POD_ACCESS_UNAVAILABLE, 401, 'authentication_required' ],
    [ CALLER_OWNER_MISMATCH, 403, 'pod_owner_mismatch' ],
    [ POD_INTERFACE_KEY_MISSING, 403, 'service_access_missing' ],
    [ 'pod_interface_key_rejected:401', 403, 'service_access_missing' ],
    [ 'caller_dpop_replay_unsupported', 403, 'service_access_missing' ],
    [ 'service_access_missing', 403, 'service_access_missing' ],
  ])('maps %s to %i %s', (message, status, error) => {
    expect(podAccessFailureResponse(new Error(message))).toEqual({ status, error });
  });

  it('leaves unrelated failures alone', () => {
    expect(podAccessFailureResponse(new Error('database is down'))).toBeUndefined();
    expect(podAccessFailureResponse(undefined)).toBeUndefined();
  });
});

describe('guardPodAccessRoute', () => {
  function response() {
    return {
      statusCode: 0,
      headers: {} as Record<string, string>,
      body: '',
      setHeader(name: string, value: string) { this.headers[name] = value; },
      end(chunk: string) { this.body = chunk; },
    };
  }

  it('answers the mapped status for a Pod access failure', async () => {
    const res = response();
    const handler = guardPodAccessRoute(async() => {
      throw new Error(POD_INTERFACE_KEY_MISSING);
    });

    await handler({}, res, {});

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'service_access_missing' });
  });

  it('propagates anything that is not a Pod access failure', async () => {
    const res = response();
    const handler = guardPodAccessRoute(async() => {
      throw new Error('database is down');
    });

    await expect(handler({}, res, {})).rejects.toThrow('database is down');
    expect(res.statusCode).toBe(0);
  });

  it('passes the request through to the route', async () => {
    const res = response();
    const inner = vi.fn(async() => undefined);
    const handler = guardPodAccessRoute(inner);

    await handler({ url: '/v1/chatkit/threads' }, res, { thread_id: 'thread-1' });

    expect(inner).toHaveBeenCalledWith({ url: '/v1/chatkit/threads' }, res, { thread_id: 'thread-1' });
    expect(res.statusCode).toBe(0);
  });
});
