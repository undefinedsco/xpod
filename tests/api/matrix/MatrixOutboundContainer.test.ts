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

describe('outbound federation registration', () => {
  it('builds a delivery from the deployment identity and hands its queue to the store', () => {
    const instance = container(identity('pod.example'));
    const delivery = instance.resolve('matrixOutboundDelivery');
    expect(delivery).toBeDefined();
    expect(delivery!.sender).toBeDefined();
    expect(delivery!.resolver).toBeDefined();

    // The store the routes use is the one holding that queue: this is the link between the
    // write path and federation, and it is easy to lose in a refactor.
    expect(instance.resolve('matrixStore').getOutbox()).toBe(delivery!.outbox);
    // The same registry the store signs with is the one the sender picks origins from.
    expect(instance.resolve('matrixSigningIdentities').serverNames()).toEqual([ 'pod.example' ]);
  });

  it('registers no delivery, and no queue, without an identity of its own', () => {
    const instance = container(undefined);
    expect(instance.resolve('matrixOutboundDelivery')).toBeUndefined();
    expect(instance.resolve('matrixStore').getOutbox()).toBeUndefined();
  });
});
