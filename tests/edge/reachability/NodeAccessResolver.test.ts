import { describe, expect, it, vi } from 'vitest';
import { createPodOwnershipNodeAccessResolver } from '../../../src/edge/reachability/NodeAccessResolver';

describe('createPodOwnershipNodeAccessResolver', () => {
  const alice = 'https://alice.example/profile/card#me';
  const bob = 'https://bob.example/profile/card#me';

  it('authorizes a WebID that owns a Pod hosted on the node', async () => {
    const resolver = createPodOwnershipNodeAccessResolver({
      listAllPods: vi.fn().mockResolvedValue([
        { podId: 'pod-1', accountId: 'acct-1', baseUrl: 'https://pods.example/alice/', webId: alice, nodeId: 'node-1' },
      ]),
    } as any);

    expect(await resolver('node-1', alice)).toBe(true);
    // The same WebID has no relationship with another node.
    expect(await resolver('node-2', alice)).toBe(false);
  });

  it('does not authorize an unrelated WebID', async () => {
    const resolver = createPodOwnershipNodeAccessResolver({
      listAllPods: vi.fn().mockResolvedValue([
        { podId: 'pod-1', accountId: 'acct-1', baseUrl: 'https://pods.example/alice/', webId: alice, nodeId: 'node-1' },
      ]),
    } as any);

    expect(await resolver('node-1', bob)).toBe(false);
  });

  it('matches every WebID listed for a Pod and the edge node alias', async () => {
    const resolver = createPodOwnershipNodeAccessResolver({
      listAllPods: vi.fn().mockResolvedValue([
        { podId: 'pod-2', accountId: 'acct-2', baseUrl: 'https://pods.example/bob/', webIds: [ bob ], edgeNodeId: 'edge-7' },
      ]),
    } as any);

    expect(await resolver('edge-7', bob)).toBe(true);
  });

  it('denies access when no Pod lookup is available or the lookup fails', async () => {
    expect(await createPodOwnershipNodeAccessResolver(undefined)('node-1', alice)).toBe(false);

    const failing = createPodOwnershipNodeAccessResolver({
      listAllPods: vi.fn().mockRejectedValue(new Error('db down')),
    } as any);
    expect(await failing('node-1', alice)).toBe(false);
  });
});
