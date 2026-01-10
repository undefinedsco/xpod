/**
 * ObservableResourceStore 单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ObservableResourceStore } from '../../src/storage/ObservableResourceStore';
import type { ResourceChangeEvent, ResourceChangeListener } from '../../src/storage/ObservableResourceStore';
import type { ResourceStore, Representation, ResourceIdentifier, ChangeMap } from '@solid/community-server';
import { Readable } from 'node:stream';

// Mock source store
function createMockStore(options: { resourceExists?: boolean } = {}): ResourceStore {
  const { resourceExists = false } = options;

  return {
    getRepresentation: vi.fn().mockImplementation(async () => {
      if (resourceExists) {
        return { data: Readable.from([]), metadata: {} };
      }
      throw new Error('Not found');
    }),
    setRepresentation: vi.fn().mockResolvedValue(new Map()),
    addResource: vi.fn().mockImplementation(async (_container, _rep) => {
      const changeMap = new Map();
      changeMap.set({ path: '/test/new-resource.txt' }, undefined);
      return changeMap;
    }),
    deleteResource: vi.fn().mockResolvedValue(new Map()),
    modifyResource: vi.fn().mockResolvedValue(new Map()),
    hasResource: vi.fn().mockResolvedValue(resourceExists),
  } as unknown as ResourceStore;
}

// Mock listener
function createMockListener(): ResourceChangeListener & { events: ResourceChangeEvent[] } {
  const events: ResourceChangeEvent[] = [];
  return {
    events,
    onResourceChanged: vi.fn().mockImplementation(async (event: ResourceChangeEvent) => {
      events.push(event);
    }),
  };
}

describe('ObservableResourceStore', () => {
  let mockStore: ResourceStore;
  let observableStore: ObservableResourceStore;
  let mockListener: ResourceChangeListener & { events: ResourceChangeEvent[] };

  beforeEach(() => {
    vi.useFakeTimers();
    mockStore = createMockStore();
    mockListener = createMockListener();
    observableStore = new ObservableResourceStore(mockStore, {
      listeners: [mockListener],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('setRepresentation', () => {
    it('should emit create event for new resource', async () => {
      const identifier: ResourceIdentifier = { path: '/test/new.txt' };
      const representation = { data: Readable.from(['test']), metadata: {} } as Representation;

      await observableStore.setRepresentation(identifier, representation);

      // 触发 setImmediate
      vi.runAllTimers();

      expect(mockListener.onResourceChanged).toHaveBeenCalledTimes(1);
      expect(mockListener.events[0]).toMatchObject({
        path: '/test/new.txt',
        action: 'create',
        isContainer: false,
      });
    });

    it('should emit update event for existing resource', async () => {
      mockStore = createMockStore({ resourceExists: true });
      observableStore = new ObservableResourceStore(mockStore, {
        listeners: [mockListener],
      });

      const identifier: ResourceIdentifier = { path: '/test/existing.txt' };
      const representation = { data: Readable.from(['test']), metadata: {} } as Representation;

      await observableStore.setRepresentation(identifier, representation);

      vi.runAllTimers();

      expect(mockListener.events[0]).toMatchObject({
        path: '/test/existing.txt',
        action: 'update',
      });
    });

    it('should identify container by trailing slash', async () => {
      const identifier: ResourceIdentifier = { path: '/test/folder/' };
      const representation = { data: Readable.from([]), metadata: {} } as Representation;

      await observableStore.setRepresentation(identifier, representation);

      vi.runAllTimers();

      expect(mockListener.events[0]).toMatchObject({
        path: '/test/folder/',
        isContainer: true,
      });
    });
  });

  describe('addResource', () => {
    it('should emit create event', async () => {
      const container: ResourceIdentifier = { path: '/test/' };
      const representation = { data: Readable.from(['test']), metadata: {} } as Representation;

      await observableStore.addResource(container, representation);

      vi.runAllTimers();

      expect(mockListener.onResourceChanged).toHaveBeenCalled();
      expect(mockListener.events[0]).toMatchObject({
        action: 'create',
      });
    });
  });

  describe('deleteResource', () => {
    it('should emit delete event', async () => {
      const identifier: ResourceIdentifier = { path: '/test/to-delete.txt' };

      await observableStore.deleteResource(identifier);

      vi.runAllTimers();

      expect(mockListener.events[0]).toMatchObject({
        path: '/test/to-delete.txt',
        action: 'delete',
      });
    });
  });

  describe('modifyResource', () => {
    it('should emit update event', async () => {
      const identifier: ResourceIdentifier = { path: '/test/to-modify.txt' };
      const patch = { data: Readable.from(['patch']), metadata: {} } as Representation;

      await observableStore.modifyResource(identifier, patch);

      vi.runAllTimers();

      expect(mockListener.events[0]).toMatchObject({
        path: '/test/to-modify.txt',
        action: 'update',
      });
    });
  });

  describe('listener management', () => {
    it('should support adding listeners dynamically', async () => {
      const newListener = createMockListener();
      observableStore.addListener(newListener);

      const identifier: ResourceIdentifier = { path: '/test/file.txt' };
      const representation = { data: Readable.from(['test']), metadata: {} } as Representation;

      await observableStore.setRepresentation(identifier, representation);

      vi.runAllTimers();

      expect(mockListener.events.length).toBe(1);
      expect(newListener.events.length).toBe(1);
    });

    it('should support removing listeners', async () => {
      observableStore.removeListener(mockListener);

      const identifier: ResourceIdentifier = { path: '/test/file.txt' };
      const representation = { data: Readable.from(['test']), metadata: {} } as Representation;

      await observableStore.setRepresentation(identifier, representation);

      vi.runAllTimers();

      expect(mockListener.events.length).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should not block on listener errors', async () => {
      const errorListener: ResourceChangeListener = {
        onResourceChanged: vi.fn().mockRejectedValue(new Error('Listener failed')),
      };
      observableStore.addListener(errorListener);

      const identifier: ResourceIdentifier = { path: '/test/file.txt' };
      const representation = { data: Readable.from(['test']), metadata: {} } as Representation;

      // Should not throw
      await observableStore.setRepresentation(identifier, representation);

      vi.runAllTimers();

      // Both listeners should be called
      expect(mockListener.onResourceChanged).toHaveBeenCalled();
      expect(errorListener.onResourceChanged).toHaveBeenCalled();
    });
  });

  describe('async behavior', () => {
    it('should not block main operation', async () => {
      const slowListener: ResourceChangeListener = {
        onResourceChanged: vi.fn().mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }),
      };
      observableStore.addListener(slowListener);

      const identifier: ResourceIdentifier = { path: '/test/file.txt' };
      const representation = { data: Readable.from(['test']), metadata: {} } as Representation;

      const start = Date.now();
      await observableStore.setRepresentation(identifier, representation);
      const elapsed = Date.now() - start;

      // Main operation should complete immediately
      expect(elapsed).toBeLessThan(100);
    });
  });
});
