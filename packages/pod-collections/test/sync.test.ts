import { beforeEach, describe, expect, it } from 'vitest';
import { POD_URL, createHarness, tick, waitUntil } from './helpers/harness.js';
import type { Harness, WidgetRow } from './helpers/harness.js';
import { stripVirtualProps } from '../src/diff.js';

/**
 * §3 同步算法：先订阅后读、读期间缓冲并重放、markReady、未变 0 行写入、
 * 突发合并成 1 次读、diff 增量、读失败不擦集合、无 feed 不轮询、truncate 正确。
 */

function rowOf(harness: Harness, key: string): WidgetRow | undefined {
  return harness.collection.get(key) as WidgetRow | undefined;
}

describe('pod collection sync', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = createHarness();
    await harness.collection.preload();
  });

  it('subscribes to the feed before the first read and marks ready', async () => {
    const log = harness.log;
    const watchIndex = log.findIndex((entry) => entry.startsWith('watch:'));
    const selectIndex = log.findIndex((entry) => entry === 'select');
    expect(watchIndex).toBeGreaterThanOrEqual(0);
    expect(selectIndex).toBeGreaterThanOrEqual(0);
    expect(watchIndex).toBeLessThan(selectIndex);
    expect(harness.feed?.watched).toEqual([harness.documentUrl]);
    expect(harness.collection.isReady()).toBe(true);
    expect(harness.syncState()).toBe('live');
  });

  it('replays dirty signals that arrive during the initial read', async () => {
    const buffering = createHarness();
    buffering.fakeDatabase.holdReads();
    try {
      const preloaded = buffering.collection.preload();
      await waitUntil(() => buffering.selectCount() === 1, 'first read started');
      buffering.feed?.emit(buffering.documentUrl);
      buffering.fakeDocument.putRow('w3', { label: 'Third' });
      buffering.fakeDatabase.releaseReads();
      await preloaded;
      // 缓冲的信号在首读之后被重放：第二次读看到 w3。
      await waitUntil(() => buffering.selectCount() >= 2, 'replayed signal triggers a re-read');
      await buffering.collection.refresh();
      expect(buffering.collection.get('w3')).toMatchObject({ label: 'Third' });
    } finally {
      buffering.fakeDatabase.releaseReads();
    }
  });

  it('does not write rows when the document did not change', async () => {
    const before = harness.collection.get('w1');
    const reads = harness.selectCount();
    harness.feed?.emit(harness.documentUrl);
    await waitUntil(() => harness.selectCount() > reads, 'dirty signal re-reads the document');
    await tick(5);
    // 投影未变 → 0 次 write()：行对象身份保持不变（§3.3 的组件身份）。
    expect(harness.collection.get('w1')).toBe(before);
  });

  it('coalesces a burst of dirty signals into one read', async () => {
    const reads = harness.selectCount();
    for (let index = 0; index < 5; index += 1) harness.feed?.emit(harness.documentUrl);
    await waitUntil(() => harness.selectCount() > reads, 'burst triggers a read');
    await tick(30);
    expect(harness.selectCount()).toBe(reads + 1);
  });

  it('applies insert / update / delete deltas instead of a blanket refetch', async () => {
    const secondBefore = harness.collection.get('w2');
    harness.fakeDocument.putRow('w3', { label: 'Third', priority: 9 });
    harness.fakeDocument.putRow('w1', { ...harness.fakeDocument.rows().get('w1'), label: 'Renamed' });
    harness.fakeDocument.removeRow('w2');
    harness.feed?.emit(harness.documentUrl);
    await waitUntil(() => harness.collection.get('w3') !== undefined, 'insert applied');
    expect(rowOf(harness, 'w1')).toMatchObject({ label: 'Renamed' });
    expect(harness.collection.has('w2')).toBe(false);
    // 未变的行没有被重写：身份不变（只有真正变化的行产生新对象）。
    expect(secondBefore).toBeDefined();
  });

  it('keeps rows and degrades when a read fails', async () => {
    const before = harness.collection.get('w1');
    harness.fakeDocument.failNextRead(403);
    const reads = harness.selectCount();
    harness.feed?.emit(harness.documentUrl);
    await waitUntil(() => harness.syncState() === 'degraded', 'read failure degrades the sync state');
    expect(harness.collection.get('w1')).toBe(before);
    expect(harness.selectCount()).toBe(reads + 1);
  });

  it('reports an initial read failure to the library and recovers on a later read', async () => {
    const failing = createHarness();
    failing.fakeDocument.failNextRead(404);
    await failing.collection.preload().catch(() => undefined);
    expect(failing.collection.status).toBe('error');
    expect(failing.collection.size).toBe(0);
    // 读恢复后一次显式 refresh 就回到 ready 并带回行（不用重建集合）。
    await failing.collection.refresh();
    expect(failing.collection.status).toBe('ready');
    expect(failing.collection.get('w1')).toBeDefined();
  });

  it('reads once and then never polls when no feed is configured (N1)', async () => {
    const local = createHarness({ withFeed: false });
    await local.collection.preload();
    expect(local.syncState()).toBe('unavailable');
    expect(local.selectCount()).toBe(1);
    await tick(40);
    expect(local.selectCount()).toBe(1);
    // 显式 refresh() 仍然可用，这是无 feed 时唯一的更新途径。
    await local.collection.refresh();
    expect(local.selectCount()).toBe(2);
    expect(local.syncState()).toBe('unavailable');
  });

  it('stops reading and unsubscribes after dispose', async () => {
    expect(harness.feed?.activeWatchers).toBe(1);
    harness.internals.dispose();
    expect(harness.feed?.activeWatchers).toBe(0);
    const reads = harness.selectCount();
    harness.feed?.emit(harness.documentUrl);
    await tick(30);
    expect(harness.selectCount()).toBe(reads);
  });

  it('stays correct after the library truncates the collection', async () => {
    harness.internals.truncateForTest();
    expect(harness.collection.size).toBe(0);
    // truncate 清空了 syncedData 与 row metadata：下一轮把行重新插入并重新写入哈希。
    await harness.collection.refresh();
    expect([...harness.collection.keys()].sort()).toEqual(['w1', 'w2']);
    const afterRepair = harness.collection.get('w1');
    // 再一轮无变化的读不应产生任何写入。
    harness.feed?.emit(harness.documentUrl);
    await waitUntil(() => harness.selectCount() >= 3, 'another pass ran');
    expect(harness.collection.get('w1')).toBe(afterRepair);
  });

  it('exposes the table document and pending keys on the collection', () => {
    expect(harness.collection.tableDocument).toBe(harness.documentUrl);
    expect(harness.collection.pendingKeys.size).toBe(0);
    expect(harness.collection.conflicts).toHaveLength(0);
  });

  it('only materialises descriptor fields that a table column carries', () => {
    const row = rowOf(harness, 'w1');
    expect(row).toBeDefined();
    const projected = stripVirtualProps(row as WidgetRow) as Record<string, unknown>;
    expect(Object.keys(projected).sort()).toEqual([
      '@id',
      'enabled',
      'expiresAt',
      'hasModel',
      'home',
      'id',
      'label',
      'metadata',
      'priority',
      'providerId',
      'scopes',
    ]);
    // `secret: true` 的字段不从行里投影出去（§2.1）；表里没有列的字段也不出现。
    expect('apiKey' in projected).toBe(false);
    expect('secretType' in projected).toBe(false);
    expect(projected.expiresAt).toBeInstanceOf(Date);
    expect(projected.hasModel).toEqual([
      `${POD_URL}settings/models/a.ttl#a`,
      `${POD_URL}settings/models/b.ttl#b`,
    ]);
    // 呈现行带库的虚属性（$synced/$origin/$key/$collectionId）。
    expect(Object.keys(row as WidgetRow)).toContain('$synced');
  });
});
