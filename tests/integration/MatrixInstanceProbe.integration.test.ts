/**
 * The deployment's own endpoints, probed on a running instance of this branch.
 *
 * The acceptance ledger wanted a real instance rather than a mock, and Docker was the blocked road
 * to one. The lite gate already runs a real stack from this branch — gateway, CSS, API, real Pods —
 * so the probes the ledger lists can be made against it: what a peer sees, and what an unsigned
 * caller is told. Nothing here needs credentials; that is the point (a route that answers without
 * them is a route that authenticates nobody).
 *
 * The retired native path (`/_xpod/matrix/inbound`) is not probed any more: its client and its route
 * are gone, so there is nothing to answer there. The remaining probes are the ones the ledger lists.
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

  it('refuses an unsigned federation request instead of processing it', async() => {
    // A transaction with no signature is not processed at all. Which refusal comes back depends on
    // the order the handler works in: it first asks whether this deployment *serves* the name it was
    // addressed as (403 when it does not), and only then checks the signature (401). Both are
    // refusals, and pinning one of them would make this probe depend on which names the stack
    // happens to serve — so it asserts the refusal, not the code.
    const send = await probe('/_matrix/federation/v1/send/unsigned-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: 'stranger.example', pdus: [] }),
    });
    expect([ 401, 403 ]).toContain(send.status);
    expect([ 'M_UNAUTHORIZED', 'M_FORBIDDEN' ]).toContain(send.body.errcode);

    // Reads are signed too — asked about a name this deployment *serves*. A query about somebody
    // else's name is a 404 before any signature is checked (the handler resolves the addressed name
    // first, which is also how a peer learns whether this deployment serves it at all).
    const served = new URL(baseUrl).host;
    const directory = await probe(`/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(`#nobody:${served}`)}`);
    expect([ 401, 403, 404 ]).toContain(directory.status);
    expect(typeof directory.body.errcode).toBe('string');
  });

  it('tells a peer which implementation is answering, without asking who it is', async() => {
    // `/version` is the one endpoint that is deliberately unsigned: it says what is running.
    const version = await probe('/_matrix/federation/v1/version');
    expect(version.status).toBe(200);
    expect(version.body).toMatchObject({ server: expect.objectContaining({ name: expect.any(String), version: expect.any(String) }) });
  });
});
