import { asValue, createContainer } from 'awilix';
import { describe, expect, it, vi } from 'vitest';
import { registerCommonServices } from '../../../src/api/container/common';
import type { PodMatrixOutboundStore } from '../../../src/api/matrix/federation/podOutboundStore';

const scope = 'https://pod.example/owner/';
const webId = `${scope}profile/card#me`;
const binding = { purpose: 'membership' as const, credentialRef: 'taskcred_explicit', version: 2, issuer: 'https://issuer.example/' };
const batch = { txnId: 'publication', origin: 'pod.example', destination: 'peer.example', attempts: 0, createdAt: 1,
  pdus: [ { event_id: '$publication', type: 'co.undefineds.membership.authority', state_key: '', sender: webId, content: binding } ],
  edus: [], actor: { webId, podUrl: scope, taskCredential: binding } };

function fixture(revokeOnMint = false) {
  const container = createContainer();
  registerCommonServices(container as never);
  let revoked = false;
  const transport = vi.fn(async(input: RequestInfo | URL, _init?: RequestInit) => {
    const response = new Response(null, { status: 404 });
    Object.defineProperty(response, 'url', { value: String(input) });
    return response;
  });
  const lease = vi.fn(async() => {
    if (revoked) throw new Error('Revoked fixture');
    return { credentialRef: binding.credentialRef, ownerWebId: webId, version: binding.version, issuer: binding.issuer };
  });
  const getPodFetch = vi.fn(async(owner: string, context: Record<string, unknown>) => {
    expect(owner).toBe(webId);
    expect(context.auth).toBeUndefined();
    expect(context.taskCredential).toEqual(binding);
    const guard = context.beforeRequest as () => Promise<void>;
    expect(typeof guard).toBe('function');
    if (revokeOnMint) revoked = true;
    return async(input: RequestInfo | URL, init?: RequestInit) => { await guard(); return await transport(input, init); };
  });
  container.register({
    config: asValue({ matrixServiceIdentity: {}, solidBaseUrl: binding.issuer }),
    matrixSigningIdentities: asValue({}), matrixServerNameResolver: asValue({}), matrixFederationFetch: asValue(undefined),
    ownerPodAccess: asValue({ getPodFetch }), taskCredentialStore: asValue({ lease }),
    matrixParticipantRoutes: asValue({ routes: async() => ({ served: new Map([ [ 'owner', { webId, podUrl: scope } ] ]) }) }),
    matrixStore: asValue({ controlRecordHandleFor: () => { throw new Error('Ambient activeFor path called'); } }),
  });
  const delivery = container.resolve('matrixOutboundDelivery');
  return { delivery, store: delivery.store as PodMatrixOutboundStore, transport, getPodFetch, lease,
    revoke: () => { revoked = true; } };
}

describe('production publication background authority wiring', () => {
  it('uses a fresh explicit task principal for the marker carrier', async() => {
    const f = fixture();
    await f.store.removePublicationExact(scope, batch);
    expect(f.getPodFetch).toHaveBeenCalledTimes(1);
    expect(f.lease).toHaveBeenCalledWith({ credentialRef: binding.credentialRef, ownerWebId: webId, version: 2, recordUsage: false });
    expect(f.transport).toHaveBeenCalledTimes(1);
  });

  it('rejects a revoked publication before sending or obtaining an old transport', async() => {
    const f = fixture(); f.revoke();
    vi.spyOn(f.store, 'pending').mockResolvedValue([ batch ]);
    const send = vi.spyOn(f.delivery.sender, 'send');
    await expect(f.delivery.outbox.flush({ scope })).rejects.toThrow('Revoked fixture');
    expect(send).not.toHaveBeenCalled();
    expect(f.getPodFetch).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('rejects a stale version or non-served actor without carrier effects', async() => {
    const f = fixture();
    const stale = { ...batch, actor: { ...batch.actor, taskCredential: { ...binding, version: 1 } } };
    await expect(f.store.removePublicationExact(scope, stale)).rejects.toThrow('Current publication authority differs');
    await expect(f.store.removePublicationExact(scope, { ...batch, actor: { ...batch.actor, webId: `${webId}-other` } })).rejects.toThrow('exact served participant');
    expect(f.getPodFetch).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
  });
});


it('rechecks a lease revoked after task transport resolution before its physical carrier GET', async() => {
  const f = fixture(true);
  await expect(f.store.removePublicationExact(scope, batch)).rejects.toThrow('Revoked fixture');
  expect(f.getPodFetch).toHaveBeenCalledTimes(1);
  expect(f.transport).not.toHaveBeenCalled();
});
