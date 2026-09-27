import { generateKeyPairSync } from 'node:crypto';
import { asValue, createContainer } from 'awilix';
import { describe, expect, it } from 'vitest';
import { registerCommonServices } from '../../../src/api/container/common';
import type { ApiContainerCradle } from '../../../src/api/container/types';
import { MatrixServiceIdentity } from '../../../src/api/matrix/protocol/serviceIdentity';

function identity(serverName: string): MatrixServiceIdentity {
  const { privateKey } = generateKeyPairSync('ed25519');
  return new MatrixServiceIdentity({
    serverName,
    activeKey: { keyId: 'ed25519:1', privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() },
  });
}

/** The production registrations, with only the pieces that need a live database stubbed. */
function container(matrixServiceIdentity: MatrixServiceIdentity | undefined) {
  const instance = createContainer<ApiContainerCradle>();
  registerCommonServices(instance);
  instance.register({
    config: asValue({ edition: 'local', matrixServiceIdentity } as ApiContainerCradle['config']),
    ownerPodAccess: asValue(undefined as unknown as ApiContainerCradle['ownerPodAccess']),
    // The journal is the only thing the store constructs from the database, and it does not
    // touch it until a write.
    db: asValue({} as ApiContainerCradle['db']),
    // Registered by each edition, not by `registerCommonServices`; absent here so participant
    // provisioning stays off, exactly as it would in an edition that never registers it.
    podLookupRepo: asValue(undefined as unknown as ApiContainerCradle['podLookupRepo']),
  });
  return instance;
}

describe('inbound routing registration', () => {
  it('derives the routes from the Pod registrations the deployment already keeps', async () => {
    const instance = container(identity('pod.example'));
    // Without a Pod registry there is nothing to derive, so routing is off rather than wrong.
    expect(instance.resolve('matrixParticipantRoutes')).toBeUndefined();

    const withPods = container(identity('pod.example'));
    withPods.register({
      podLookupRepo: asValue({
        listAllPods: async () => [
          { podId: 'pod-1', accountId: 'a-1', baseUrl: 'https://pod.example/alice', webId: 'https://alice.example/card#me' },
        ],
      } as unknown as ApiContainerCradle['podLookupRepo']),
    });
    const routes = withPods.resolve('matrixParticipantRoutes');
    expect(routes).toBeDefined();
    await expect(routes!.route('alice.example')).resolves.toMatchObject({
      kind: 'served',
      route: { podUrl: 'https://pod.example/alice/' },
    });
  });
});

describe('room watching registration', () => {
  it('watches the served Pods when there is a Pod registry and an identity', async () => {
    const withoutRegistry = container(identity('pod.example'));
    // No Pod registry means no served names, so there is nothing to watch — and sync reads
    // everything, which is the behaviour without a source.
    expect(withoutRegistry.resolve('matrixRoomWatchService')).toBeUndefined();

    const instance = container(identity('pod.example'));
    instance.register({
      podLookupRepo: asValue({
        listAllPods: async () => [
          { podId: 'pod-1', accountId: 'a-1', baseUrl: 'https://pod.example/alice', webId: 'https://alice.example/card#me' },
        ],
      } as unknown as ApiContainerCradle['podLookupRepo']),
    });
    const watch = instance.resolve('matrixRoomWatchService');
    expect(watch).toBeDefined();
    // The store syncs through that same source: this is the link between the watcher and the
    // bounded read path, and it is easy to lose in a refactor.
    expect(instance.resolve('matrixStore').getRoomChanges()).toBe(watch);
    // Started by the runtime, not by construction: an unwatched scope answers "read everything".
    await expect(watch!.pending({ scope: 'https://pod.example/alice/' }))
      .resolves.toEqual({ trust: 'all', rooms: [] });
    expect(watch!.isRunning).toBe(false);
  });
});

describe('outbound federation registration', () => {
  it('builds a delivery from the deployment identity and hands its queue to the store', async () => {
    const instance = container(identity('pod.example'));
    const delivery = instance.resolve('matrixOutboundDelivery');
    expect(delivery).toBeDefined();
    expect(delivery!.sender).toBeDefined();
    expect(delivery!.resolver).toBeDefined();

    // The store the routes use hands what it writes to that queue: this is the link between the
    // write path and federation, and it is easy to lose in a refactor.
    const outbound = instance.resolve('matrixStore').getOutbox();
    expect(outbound).toBeDefined();
    expect(typeof outbound!.enqueue).toBe('function');
    // And something drives that queue in production.
    const scheduler = instance.resolve('matrixOutboxScheduler');
    expect(scheduler).toBeDefined();
    await expect(scheduler!.flushOnce()).resolves.toMatchObject({ scopes: 0, failed: 0 });
    // The same registry the store signs with is the one the sender picks origins from.
    expect(instance.resolve('matrixSigningIdentities').serverNames()).toEqual([ 'pod.example' ]);
  });

  it('registers no delivery, and no queue, without an identity of its own', () => {
    const instance = container(undefined);
    expect(instance.resolve('matrixOutboundDelivery')).toBeUndefined();
    expect(instance.resolve('matrixStore').getOutbox()).toBeUndefined();
    expect(instance.resolve('matrixOutboxScheduler')).toBeUndefined();
  });
});
