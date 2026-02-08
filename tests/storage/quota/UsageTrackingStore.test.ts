import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { ResourceIdentifier } from '@solid/community-server/dist/http/representation/ResourceIdentifier';
import type { Representation } from '@solid/community-server/dist/http/representation/Representation';
import type { ChangeMap } from '@solid/community-server/dist/storage/ResourceStore';

vi.mock('@solid/community-server', () => {
  class PassthroughStore<T = any> {
    protected readonly source: T;

    public constructor(source: T) {
      this.source = source;
    }

    public addResource(...args: any[]): any {
      return (this.source as any).addResource(...args);
    }

    public setRepresentation(...args: any[]): any {
      return (this.source as any).setRepresentation(...args);
    }

    public getRepresentation(...args: any[]): any {
      return (this.source as any).getRepresentation(...args);
    }

    public deleteResource(...args: any[]): any {
      return (this.source as any).deleteResource(...args);
    }
  }

  return {
    PassthroughStore,
    guardStream: (stream: unknown) => stream,
  };
});

import { UsageTrackingStore } from '../../../src/storage/quota/UsageTrackingStore';

type MockUsageRepo = {
  incrementUsage: ReturnType<typeof vi.fn>;
  getAccountUsage: ReturnType<typeof vi.fn>;
  getPodUsage: ReturnType<typeof vi.fn>;
};

const usageRepoInstances: MockUsageRepo[] = [];
const podLookupInstances: Array<{ findByResourceIdentifier: ReturnType<typeof vi.fn> }> = [];

vi.mock('../../../src/storage/quota/UsageRepository', () => ({
  UsageRepository: vi.fn().mockImplementation(() => {
    const instance: MockUsageRepo = {
      incrementUsage: vi.fn(),
      getAccountUsage: vi.fn().mockResolvedValue(undefined),
      getPodUsage: vi.fn().mockResolvedValue(undefined),
    };
    usageRepoInstances.push(instance);
    return instance;
  }),
}));

vi.mock('../../../src/identity/drizzle/PodLookupRepository', () => ({
  PodLookupRepository: vi.fn().mockImplementation(() => {
    const instance = {
      findByResourceIdentifier: vi.fn(),
    };
    podLookupInstances.push(instance);
    return instance;
  }),
}));

vi.mock('../../../src/identity/drizzle/db', () => ({
  getIdentityDatabase: vi.fn(() => ({})),
}));

type StoredResourceFactory = () => Representation;

function createBinaryRepresentation(buffer: Buffer): Representation {
  return {
    binary: true,
    metadata: {},
    data: Readable.from([ buffer ]),
  } as Representation;
}

function createStore(options: { defaultBandwidthLimit?: number | null } = {}) {
  const storedResources = new Map<string, StoredResourceFactory>();

  async function drainRepresentation(representation?: Representation): Promise<void> {
    if (!representation?.data) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      representation.data.on('error', reject);
      representation.data.on('end', resolve);
      representation.data.on('close', resolve);
      if (typeof representation.data.resume === 'function') {
        representation.data.resume();
      }
    });
  }

  const baseStore = {
    addResource: vi.fn(async (_container: ResourceIdentifier, representation?: Representation): Promise<ChangeMap> => {
      await drainRepresentation(representation);
      return {} as ChangeMap;
    }),
    setRepresentation: vi.fn(async (_identifier: ResourceIdentifier, representation?: Representation): Promise<ChangeMap> => {
      await drainRepresentation(representation);
      return {} as ChangeMap;
    }),
    deleteResource: vi.fn(async (_identifier: ResourceIdentifier): Promise<ChangeMap> => {
      return {} as ChangeMap;
    }),
    getRepresentation: vi.fn(async (identifier: ResourceIdentifier): Promise<Representation> => {
      const factory = storedResources.get(identifier.path);
      if (!factory) {
        throw new Error('NotFound');
      }
      return factory();
    }),
  };

  const store = new UsageTrackingStore(baseStore as any, {
    identityDbUrl: 'postgres://localhost/test',
    defaultAccountBandwidthLimitBps: options.defaultBandwidthLimit ?? null,
  });

  const podLookup = podLookupInstances[podLookupInstances.length - 1];
  const usageRepo = usageRepoInstances[usageRepoInstances.length - 1];

  return {
    store,
    baseStore,
    usageRepo,
    podLookup,
    setExistingBinary(path: string, buffer: Buffer): void {
      storedResources.set(path, () => createBinaryRepresentation(Buffer.from(buffer)));
    },
    clearExisting(path: string): void {
      storedResources.delete(path);
    },
  };
}

describe('UsageTrackingStore', () => {
  beforeEach(() => {
    usageRepoInstances.splice(0, usageRepoInstances.length);
    podLookupInstances.splice(0, podLookupInstances.length);
  });

  it('addResource 会根据新增大小累计存储并记录入站带宽', async () => {
    const { store, usageRepo, podLookup } = createStore();
    const identifier = { path: 'https://pods.example.com/alice/profile/card' } as ResourceIdentifier;
    podLookup.findByResourceIdentifier.mockResolvedValue({ accountId: 'acc-1', podId: 'pod-1' });
    const representation: Representation = {
      binary: true,
      metadata: {},
      data: Readable.from([ Buffer.from('hello') ]),
    } as Representation;

    await store.addResource(identifier, representation);

    expect(usageRepo.incrementUsage).toHaveBeenCalledWith(
      'acc-1',
      'pod-1',
      Buffer.byteLength('hello'),
      Buffer.byteLength('hello'),
      0,
    );
  });

  it('setRepresentation 会读取现有大小计算增量', async () => {
    const { store, usageRepo, podLookup, setExistingBinary } = createStore();
    const identifier = { path: 'https://pods.example.com/alice/inbox/' } as ResourceIdentifier;
    podLookup.findByResourceIdentifier.mockResolvedValue({ accountId: 'acc-2', podId: 'pod-2' });
    setExistingBinary(identifier.path, Buffer.alloc(4));
    const representation: Representation = {
      binary: false,
      metadata: { contentLength: '10' },
    } as Representation;

    await store.setRepresentation(identifier, representation);

    expect(usageRepo.incrementUsage).toHaveBeenNthCalledWith(1, 'acc-2', 'pod-2', 6, 0, 0);
    expect(usageRepo.incrementUsage).toHaveBeenNthCalledWith(2, 'acc-2', 'pod-2', 0, 10, 0);
  });

  it('deleteResource 会扣减存储用量', async () => {
    const { store, usageRepo, podLookup, setExistingBinary } = createStore();
    const identifier = { path: 'https://pods.example.com/carl/old.txt' } as ResourceIdentifier;
    podLookup.findByResourceIdentifier.mockResolvedValue({ accountId: 'acc-3', podId: 'pod-3' });
    setExistingBinary(identifier.path, Buffer.alloc(7));

    await store.deleteResource(identifier);

    expect(usageRepo.incrementUsage).toHaveBeenCalledTimes(1);
    expect(usageRepo.incrementUsage).toHaveBeenCalledWith('acc-3', 'pod-3', -7, 0, 0);
  });

  it('getRepresentation 会记录出站带宽并应用 Pod 限速', async () => {
    const { store, usageRepo, podLookup, setExistingBinary, baseStore } = createStore();
    const identifier = { path: 'https://pods.example.com/dave/profile/card' } as ResourceIdentifier;
    podLookup.findByResourceIdentifier.mockResolvedValue({ accountId: 'acc-4', podId: 'pod-4' });
    setExistingBinary(identifier.path, Buffer.from('world'));
    usageRepo.getPodUsage.mockResolvedValueOnce({ podId: 'pod-4', accountId: 'acc-4', storageBytes: 0, ingressBytes: 0, egressBytes: 0, bandwidthLimitBps: 2048 });

    const representation = await store.getRepresentation(identifier, {} as any);
    expect(baseStore.getRepresentation).toHaveBeenCalled();

    await new Promise<void>((resolve, reject) => {
      representation.data.on('error', reject);
      representation.data.on('end', resolve);
      representation.data.resume();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(usageRepo.incrementUsage).toHaveBeenCalledWith('acc-4', 'pod-4', 0, 0, Buffer.byteLength('world'));
  });

  it('带宽限速未配置时落回默认值', async () => {
    const { store, usageRepo, podLookup, setExistingBinary } = createStore({ defaultBandwidthLimit: 4096 });
    const identifier = { path: 'https://pods.example.com/emma/profile/card' } as ResourceIdentifier;
    podLookup.findByResourceIdentifier.mockResolvedValue({ accountId: 'acc-5', podId: 'pod-5' });
    setExistingBinary(identifier.path, Buffer.from('data'));
    usageRepo.getPodUsage.mockResolvedValueOnce(undefined);
    usageRepo.getAccountUsage.mockResolvedValueOnce({ accountId: 'acc-5', storageBytes: 0, ingressBytes: 0, egressBytes: 0, storageLimitBytes: undefined, bandwidthLimitBps: undefined });

    const result = await store.getRepresentation(identifier, {} as any);
    await new Promise<void>((resolve, reject) => {
      result.data.on('error', reject);
      result.data.on('end', resolve);
      result.data.resume();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(usageRepo.getPodUsage).toHaveBeenCalledWith('pod-5');
    expect(usageRepo.incrementUsage).toHaveBeenCalledWith('acc-5', 'pod-5', 0, 0, Buffer.byteLength('data'));
  });
});
