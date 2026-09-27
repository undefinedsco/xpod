import { describe, expect, it, vi } from 'vitest';
import { createPodParticipantIdentityProvider } from '../../../src/api/matrix/podParticipantIdentity';
import type { MatrixSigningIdentityProvider } from '../../../src/api/matrix/signingKeyStore';
import type { MatrixStoreContext } from '../../../src/api/matrix/types';

const ALICE = 'https://alice.example/profile/card#me';
const ALICE_POD = 'https://pod.example/alice/';

function pod(baseUrl: string) {
  return { podId: `pod-${baseUrl}`, accountId: 'account-1', baseUrl };
}

function fakeProvider(): MatrixSigningIdentityProvider {
  return {} as MatrixSigningIdentityProvider;
}

function harness(options: {
  pods?: Record<string, { podId: string; accountId: string; baseUrl: string }[]>;
  alreadySigns?: string[];
  provision?: (input: { serverName: string; ownerWebId: string; podUrl: string }) => Promise<unknown>;
} = {}) {
  const names = new Set(options.alreadySigns ?? []);
  const register = vi.fn((serverName: string) => { names.add(serverName); });
  const findAllByWebId = vi.fn(async (webId: string) => options.pods?.[webId] ?? []);
  const provision = vi.fn(options.provision ?? (async () => ({ provider: fakeProvider() })));
  const provider = createPodParticipantIdentityProvider({
    registry: { serverNames: () => [ ...names ], register },
    pods: { findAllByWebId },
    provision: provision as never,
  });
  const context = { webId: ALICE, podUrl: 'https://shared.example/room/' } as MatrixStoreContext;
  return { provider, register, findAllByWebId, provision, context, names };
}

describe('supplying a participant identity from their own Pod', () => {
  it('provisions in the participant\'s own Pod and attaches the identity', async () => {
    const { provider, register, provision, context, names } = harness({ pods: { [ ALICE ]: [ pod(ALICE_POD) ] } });
    await provider.ensureParticipantIdentity({ webId: ALICE, targetPodUrl: context.podUrl, context });

    // The registered Pod, not the Pod the request targets: that one belongs to the room.
    expect(provision).toHaveBeenCalledWith({ serverName: 'alice.example', ownerWebId: ALICE, podUrl: 'https://pod.example/alice', context });
    expect(register).toHaveBeenCalledWith('alice.example', expect.anything());
    expect([ ...names ]).toEqual([ 'alice.example' ]);
  });

  it('does nothing once the server name can already sign', async () => {
    const { provider, findAllByWebId, provision, context } = harness({
      alreadySigns: [ 'alice.example' ], pods: { [ ALICE ]: [ pod(ALICE_POD) ] },
    });
    await provider.ensureParticipantIdentity({ webId: ALICE, context });
    expect(findAllByWebId).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it('leaves the deployment identity in place when no Pod is registered', async () => {
    const { provider, register, provision, context } = harness({ pods: {} });
    await provider.ensureParticipantIdentity({ webId: ALICE, context });
    expect(provision).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('refuses to guess when several Pods are registered, rather than mint a second key set', async () => {
    const { provider, register, provision, context } = harness({
      pods: { [ ALICE ]: [ pod('https://a.example/alice/'), pod('https://b.example/alice/') ] },
    });
    await provider.ensureParticipantIdentity({ webId: ALICE, context });
    expect(provision).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('treats the same Pod listed twice as one Pod', async () => {
    const { provider, provision, context } = harness({
      pods: { [ ALICE ]: [ pod(ALICE_POD), pod('https://pod.example/alice') ] },
    });
    await provider.ensureParticipantIdentity({ webId: ALICE, context });
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it('skips a WebID that cannot be anybody\'s server', async () => {
    const { provider, findAllByWebId, context } = harness();
    await provider.ensureParticipantIdentity({ webId: 'mailto:alice@example.com', context });
    expect(findAllByWebId).not.toHaveBeenCalled();
  });

  it('reports a provisioning failure instead of serving the participant under another name', async () => {
    const { provider, register, context } = harness({
      pods: { [ ALICE ]: [ pod(ALICE_POD) ] },
      provision: async () => { throw new Error('No Pod access for https://alice.example/profile/card#me'); },
    });
    await expect(provider.ensureParticipantIdentity({ webId: ALICE, context })).rejects.toThrow(/No Pod access/u);
    expect(register).not.toHaveBeenCalled();
  });
});
