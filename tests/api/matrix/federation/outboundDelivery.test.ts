import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createMatrixOutboundDelivery, nodeSrvRecords } from '../../../../src/api/matrix/federation/outboundDelivery';
import { MatrixServiceIdentity } from '../../../../src/api/matrix/protocol/serviceIdentity';
import type { MatrixSigningIdentitySource } from '../../../../src/api/matrix/identityRegistry';

const ALICE = 'alice.example';
const THEM = 'remote.example';
const NOW = Date.now();

function identity(serverName: string): MatrixServiceIdentity {
  const { privateKey } = generateKeyPairSync('ed25519');
  return new MatrixServiceIdentity({
    serverName,
    activeKey: { keyId: 'ed25519:1', privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() },
    now: () => NOW,
  });
}

function identities(known: MatrixServiceIdentity[]): MatrixSigningIdentitySource {
  const byName = new Map(known.map(entry => [ entry.serverName, entry ]));
  return { identityFor: async name => byName.get(name), serverNames: () => [ ...byName.keys() ] };
}

function delivery(options: { known: MatrixServiceIdentity[]; fetch: typeof fetch; resolveSrv?: (name: string) => Promise<readonly { target: string; port: number }[] | undefined> }) {
  return createMatrixOutboundDelivery({
    identities: identities(options.known),
    fetch: options.fetch,
    now: () => NOW,
    retryRefused: { initialBackoffMs: 0, maxBackoffMs: 0, maxAttempts: 2 },
    ...(options.resolveSrv ? { resolveSrv: options.resolveSrv } : {}),
  });
}

describe('assembling the outbound path', () => {
  it('queues a written event and sends it, signed as its origin, to the resolved target', async () => {
    const alice = identity(ALICE);
    const captured: { url: string; authorization: string }[] = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const target = String(url);
      // No delegation for this destination; the resolver falls back to the implicit port.
      if (target.includes('/.well-known/')) return new Response('', { status: 404 });
      captured.push({ url: target, authorization: String((init?.headers as Record<string, string>).authorization) });
      return new Response(JSON.stringify({ pdus: { $e: {} } }), { status: 200 });
    });
    const { outbox } = delivery({ known: [ alice ], fetch: fetch as unknown as typeof fetch });

    await outbox.enqueue({ scope: 'scope', origin: ALICE, destination: THEM, pdus: [ { event_id: '$e' } ] });
    const report = await outbox.flush({ scope: 'scope' });

    expect(report.delivered).toHaveLength(1);
    // Resolution found the implicit federation port, and the request says who it is from.
    expect(captured[0].url).toBe(`https://${THEM}:8448/_matrix/federation/v1/send/${report.delivered[0]}`);
    expect(captured[0].authorization).toContain(`origin="${ALICE}"`);
    expect(captured[0].authorization).toContain(`destination="${THEM}"`);
  });

  it('uses a `.well-known` delegation when the target publishes one', async () => {
    const alice = identity(ALICE);
    const captured: string[] = [];
    const fetch = vi.fn(async (url: URL | RequestInfo) => {
      const target = String(url);
      if (target.includes('/.well-known/')) return new Response(JSON.stringify({ 'm.server': 'matrix.remote.example:9443' }), { status: 200 });
      captured.push(target);
      return new Response(JSON.stringify({ pdus: {} }), { status: 200 });
    });
    const { outbox } = delivery({ known: [ alice ], fetch: fetch as unknown as typeof fetch });

    await outbox.enqueue({ scope: 'scope', origin: ALICE, destination: THEM, pdus: [ { event_id: '$e' } ] });
    await outbox.flush({ scope: 'scope' });
    expect(captured[0]).toContain('https://matrix.remote.example:9443/_matrix/federation/v1/send/');
  });

  it('reports an origin this deployment cannot sign for instead of sending', async () => {
    const alice = identity(ALICE);
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const { outbox } = delivery({ known: [ alice ], fetch: fetch as unknown as typeof fetch });

    await outbox.enqueue({ scope: 'scope', origin: 'mallory.example', destination: THEM, pdus: [ { event_id: '$e' } ] });
    const report = await outbox.flush({ scope: 'scope' });
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0].reason).toMatch(/no signing identity/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('resolves a server name through SRV when discovery fails', async () => {
    const alice = identity(ALICE);
    const captured: string[] = [];
    const fetch = vi.fn(async (url: URL | RequestInfo) => {
      const target = String(url);
      if (target.includes('/.well-known/')) return new Response('', { status: 404 });
      captured.push(target);
      return new Response(JSON.stringify({ pdus: {} }), { status: 200 });
    });
    const resolveSrv = vi.fn(async () => [ { target: 'srv.remote.example', port: 8448 } ]);
    const { outbox } = delivery({ known: [ alice ], fetch: fetch as unknown as typeof fetch, resolveSrv });

    await outbox.enqueue({ scope: 'scope', origin: ALICE, destination: THEM, pdus: [ { event_id: '$e' } ] });
    await outbox.flush({ scope: 'scope' });
    expect(resolveSrv).toHaveBeenCalledWith(`_matrix-fed._tcp.${THEM}`);
    expect(captured[0]).toContain('https://srv.remote.example:8448/');
  });
});

describe('adapting a dns SRV answer', () => {
  it('renames the target and keeps priority and weight', () => {
    expect(nodeSrvRecords([ { name: 'matrix.example.net', port: 8448, priority: 5, weight: 10 } ])).toEqual([
      { target: 'matrix.example.net', port: 8448, priority: 5, weight: 10 },
    ]);
    expect(nodeSrvRecords([])).toEqual([]);
  });
});
