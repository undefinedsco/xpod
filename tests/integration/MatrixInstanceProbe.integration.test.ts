/**
 * The deployment's own endpoints, probed on a running instance of this branch.
 *
 * The acceptance ledger wanted a real instance rather than a mock, and Docker was the blocked road
 * to one. The lite gate already runs a real stack from this branch — gateway, CSS, API, real Pods —
 * so the probes the ledger lists can be made against it: what a peer sees, and what an unsigned
 * caller is told. Nothing here needs credentials; that is the point (a route that answers without
 * them is a route that authenticates nobody).
 *
 * Two probes are deliberately *not* asserted here, because probing them found something the ledger
 * has to carry rather than a fact to pin a test to: `/_xpod/matrix/inbound` (the native transport,
 * registered in the handler and forwarded by the gateway) answers **404** on a real instance while
 * `/_matrix/...` answers 401, and `/query/directory` answers **404** where an unsigned read was
 * expected to be refused. Both are recorded in the register with this reproduction; neither is a
 * behavior to freeze in a test.
 */
import { describe, expect, it } from 'vitest';

const RUN = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
const suite = RUN ? describe : describe.skip;
const baseUrl = (process.env.CSS_BASE_URL ?? 'http://localhost:5739').replace(/\/$/, '');

async function probe(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

suite('the running instance answers peers and strangers the way the ledger says', () => {
  it('publishes client discovery and the supported versions', async() => {
    const discovery = await probe('/.well-known/matrix/client');
    expect(discovery.status).toBe(200);
    expect(discovery.body).toMatchObject({ 'm.homeserver': { base_url: expect.stringContaining('http') } });

    const versions = await probe('/_matrix/client/versions');
    expect(versions.status).toBe(200);
    expect(Array.isArray(versions.body.versions)).toBe(true);
    expect(versions.body.versions.length).toBeGreaterThan(0);
  });

  it('answers an unsigned federation request with 401, on both transports', async() => {
    // The Matrix transport: a transaction with no signature is not processed at all.
    const send = await probe('/_matrix/federation/v1/send/unsigned-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: 'stranger.example', pdus: [] }),
    });
    expect(send.status).toBe(401);
    expect(send.body).toMatchObject({ errcode: 'M_UNAUTHORIZED' });

    // The native transport between two Xpod deployments: registered, forwarded, and just as closed.
    const native = await probe('/_xpod/matrix/inbound/unsigned-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: 'stranger.example', pdus: [] }),
    });
    expect(native.status).toBe(401);
    expect(native.body).toMatchObject({ errcode: 'M_UNAUTHORIZED' });
  });

  it('tells a peer which implementation is answering, without asking who it is', async() => {
    // `/version` is the one endpoint that is deliberately unsigned: it says what is running.
    const version = await probe('/_matrix/federation/v1/version');
    expect(version.status).toBe(200);
    expect(version.body).toMatchObject({ server: expect.objectContaining({ name: expect.any(String), version: expect.any(String) }) });
  });
});
