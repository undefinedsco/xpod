import { describe, expect, it } from 'vitest';
import { EdgeNodeRepository } from '../../../src/identity/drizzle/EdgeNodeRepository';
import { getIdentityDatabase } from '../../../src/identity/drizzle/db';
import {
  NodeMetadataConflictError,
  NodeRouteSourceNotFoundError,
  ReachabilitySessionService,
} from '../../../src/edge/reachability/ReachabilitySessionService';
import type { P2PCandidateUpdateRequest, P2PSession } from '../../../src/edge/reachability/types';

/**
 * N07: two clients adding candidates to the same node used to read the same metadata blob and
 * write it back, so the loser's candidates vanished. These tests drive the real service against
 * a real SQLite-backed repository, because the fix is about the write primitive, not about the
 * service's own bookkeeping.
 */
async function createFixture(): Promise<{
  repository: EdgeNodeRepository;
  nodeId: string;
  service: ReachabilitySessionService;
}> {
  const db = getIdentityDatabase(`sqlite::memory:n07-sessions-${Date.now()}-${Math.random()}`);
  const repository = new EdgeNodeRepository(db);
  const { nodeId } = await repository.createNode('n07-node');

  let counter = 0;
  const service = new ReachabilitySessionService({
    repository,
    apiBaseUrl: 'https://api.example.test/',
    baseStorageDomain: 'example.test',
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    randomId: () => `${++counter}`,
  });

  return { repository, nodeId, service };
}

function candidateRequest(sourceId: string, host: string): P2PCandidateUpdateRequest {
  return {
    role: 'client',
    sourceId,
    candidates: [ { id: `candidate_${sourceId}`, protocol: 'tcp', host, port: 43000 } ],
  };
}

describe('ReachabilitySessionService concurrent session writes (N07)', () => {
  it('keeps both candidate updates when two clients write at the same time', async () => {
    const { service, nodeId } = await createFixture();
    const session = await service.createP2PSession(nodeId, { clientId: 'client-a' });

    await Promise.all([
      service.addP2PCandidates(nodeId, session.sessionId, candidateRequest('client-a', '10.0.0.1')),
      service.addP2PCandidates(nodeId, session.sessionId, candidateRequest('client-b', '10.0.0.2')),
    ]);

    const stored = await service.getP2PSession(nodeId, session.sessionId);
    const hosts = stored.candidates.map((candidate) => candidate.host).sort();
    expect(hosts).toEqual([ '10.0.0.1', '10.0.0.2' ]);
  });

  it('preserves an unrelated concurrent metadata write', async () => {
    const { service, repository, nodeId } = await createFixture();
    const session = await service.createP2PSession(nodeId, { clientId: 'client-a' });

    // Simulate the probe service committing its own view of the node between the service's
    // read and its write: that write used to be the one that disappeared.
    const original = repository.updateNodeMetadataAtomic.bind(repository);
    let injected = false;
    repository.updateNodeMetadataAtomic = async (target, expected, next) => {
      if (!injected) {
        injected = true;
        await repository.mergeNodeMetadata(target, { reachability: { stage: 'ready', checkedAt: 'now' } });
      }
      return await original(target, expected, next);
    };

    await service.addP2PCandidates(nodeId, session.sessionId, candidateRequest('client-a', '10.0.0.1'));

    const metadata = (await repository.getNodeMetadata(nodeId))?.metadata ?? {};
    expect(metadata.reachability).toEqual({ stage: 'ready', checkedAt: 'now' });
    const sessions = (metadata.reachabilitySessions as { p2p?: P2PSession[] }).p2p ?? [];
    expect(sessions[0]?.candidates.map((candidate) => candidate.host)).toEqual([ '10.0.0.1' ]);
  });

  it('reports a conflict instead of silently dropping the update', async () => {
    const { service, repository, nodeId } = await createFixture();
    const session = await service.createP2PSession(nodeId, { clientId: 'client-a' });
    const before = JSON.stringify((await repository.getNodeMetadata(nodeId))?.metadata ?? null);

    // Someone keeps winning the race: retries must surface as an error, never as a lost write.
    repository.updateNodeMetadataAtomic = async () => false;

    await expect(
      service.addP2PCandidates(nodeId, session.sessionId, candidateRequest('client-a', '10.0.0.1')),
    ).rejects.toBeInstanceOf(NodeMetadataConflictError);

    expect(JSON.stringify((await repository.getNodeMetadata(nodeId))?.metadata ?? null)).toBe(before);
  });

  it('still reports a missing node as missing when retries run out', async () => {
    const { service, repository, nodeId } = await createFixture();
    const session = await service.createP2PSession(nodeId, { clientId: 'client-a' });

    repository.updateNodeMetadataAtomic = async () => false;
    repository.getNodeMetadata = async () => undefined;

    await expect(
      service.addP2PCandidates(nodeId, session.sessionId, candidateRequest('client-a', '10.0.0.1')),
    ).rejects.toBeInstanceOf(NodeRouteSourceNotFoundError);
  });

  it('does not exceed the active session limit under concurrent creates', async () => {
    const db = getIdentityDatabase(`sqlite::memory:n07-limit-${Date.now()}-${Math.random()}`);
    const repository = new EdgeNodeRepository(db);
    const { nodeId } = await repository.createNode('n07-limit');
    let counter = 0;
    const service = new ReachabilitySessionService({
      repository,
      apiBaseUrl: 'https://api.example.test/',
      baseStorageDomain: 'example.test',
      maxActiveP2PSessionsPerNode: 1,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      randomId: () => `${++counter}`,
    });

    const results = await Promise.allSettled([
      service.createP2PSession(nodeId, { clientId: 'client-a' }),
      service.createP2PSession(nodeId, { clientId: 'client-b' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const sessions = await service.listP2PSessions(nodeId);
    expect(sessions.sessions).toHaveLength(1);
  });
});
