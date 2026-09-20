import { beforeEach, describe, expect, it } from 'vitest';
import { createHarness, tick, waitUntil, widgetDescriptor } from './helpers/harness.js';
import type { Harness, WidgetRow } from './helpers/harness.js';
import { projectionCovers, projectionHash, stripVirtualProps } from '../src/diff.js';
import { createPendingWrites, reconcilePendingWrites } from '../src/mutations.js';
import { projectionFieldOrder, writeOnlyFields } from '../src/mapping.js';

/**
 * §4 乐观契约：mutation → drizzle-solid 映射、array+uri 的 PATCH 单一入口、
 * 确认协议（handler 不在服务端状态回来之前 resolve）、失败回滚、自回声不闪、
 * 外部冲突 server wins + 标记。
 */

const OLD_LABEL = 'First';

function labelOf(harness: Harness, key = 'w1'): unknown {
  const row = harness.collection.get(key) as WidgetRow | undefined;
  return row === undefined ? undefined : stripVirtualProps(row).label;
}

describe('pod collection mutations', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = createHarness();
    await harness.collection.preload();
  });

  it('maps onInsert to drizzle-solid insert and writes array+uri fields through the PATCH bypass', async () => {
    const row = {
      id: 'w3',
      label: 'Third',
      providerId: 'https://example.test/ns#openai',
      hasModel: [`${harness.podUrl}settings/models/c.ttl#c`],
      priority: 5,
    };
    const transaction = harness.collection.insert(row);
    await transaction.isPersisted.promise;

    expect(harness.fakeDatabase.calls.insert).toHaveLength(1);
    const [call] = harness.fakeDatabase.calls.insert;
    expect(call?.table).toBe('widget');
    expect(call?.values).toEqual({
      id: 'widgets.ttl#w3',
      label: 'Third',
      provider: 'https://example.test/ns#openai',
      priority: 5,
    });
    // array+uri 字段不进 ORM，走一次 PATCH（§4.1：PATCH 是这次写的全部）。
    expect(harness.fakeDatabase.fetchCalls).toHaveLength(1);
    const [patch] = harness.fakeDatabase.fetchCalls;
    expect(patch?.method).toBe('PATCH');
    expect(patch?.url).toBe(harness.documentUrl);
    expect(patch?.body).toContain('INSERT DATA');
    expect(patch?.body).toContain('<https://example.test/ns#hasModel>');
    expect(patch?.body).toContain(`<${harness.podUrl}settings/models/c.ttl#c>`);

    await harness.collection.refresh();
    expect(harness.collection.get('w3')).toMatchObject({ label: 'Third' });
    expect(harness.collection.pendingKeys.size).toBe(0);
  });

  it('maps onUpdate to updateById with column names and patches the previous uri array', async () => {
    const transaction = harness.collection.update('w1', (draft) => {
      draft.label = 'Updated';
      draft.hasModel = [`${harness.podUrl}settings/models/c.ttl#c`];
    });
    await transaction.isPersisted.promise;

    expect(harness.fakeDatabase.calls.updateById).toHaveLength(1);
    const [call] = harness.fakeDatabase.calls.updateById;
    expect(call?.id).toBe('widgets.ttl#w1');
    expect(call?.changes).toEqual({ label: 'Updated' });
    const patch = harness.fakeDatabase.fetchCalls.at(-1);
    expect(patch?.body).toContain('DELETE DATA');
    expect(patch?.body).toContain(`<${harness.podUrl}settings/models/a.ttl#a>`);
    expect(patch?.body).toContain(`<${harness.podUrl}settings/models/b.ttl#b>`);
    expect(patch?.body).toContain(`<${harness.podUrl}settings/models/c.ttl#c>`);
  });

  it('maps onDelete to deleteById and removes the row', async () => {
    const transaction = harness.collection.delete('w2');
    await transaction.isPersisted.promise;
    expect(harness.fakeDatabase.calls.deleteById).toEqual([
      { table: 'widget', id: 'widgets.ttl#w2' },
    ]);
    expect(harness.collection.has('w2')).toBe(false);
    expect(harness.fakeDocument.rows().has('w2')).toBe(false);
  });

  it('does not resolve the handler before the written value is back in the collection (self-echo, no flicker)', async () => {
    const seen: unknown[] = [];
    const subscription = harness.collection.subscribeChanges((changes) => {
      for (const change of changes) {
        if (String(change.key) === 'w1') seen.push(stripVirtualProps(change.value).label);
      }
    });
    const transaction = harness.collection.update('w1', (draft) => {
      draft.label = 'Updated';
    });
    await transaction.isPersisted.promise;
    subscription.unsubscribe();

    expect(harness.fakeDatabase.calls.select).toBeGreaterThan(1);
    // 事务完成、乐观层撤掉之后仍然是服务端值：没有回退 = 没有闪烁。
    expect(labelOf(harness)).toBe('Updated');
    expect(transaction.state).toBe('completed');
    expect(seen).not.toContain(undefined);
    // 自回声这一轮不产生可见变化（没有「回退到旧值」的事件）。
    const reverted = seen.some((value, index) => index > 0 && seen[index - 1] === 'Updated' && value === OLD_LABEL);
    expect(reverted).toBe(false);
  });

  it('retries the confirmation read and fails the transaction when the write never becomes visible', async () => {
    harness.fakeDocument.holdWrites(true);
    const transaction = harness.collection.update('w1', (draft) => {
      draft.label = 'Never';
    });
    await expect(transaction.isPersisted.promise).rejects.toMatchObject({ code: 'write_unconfirmed' });
    expect(transaction.state).toBe('failed');
    // 乐观层被库回滚：显示的还是服务端值。
    expect(labelOf(harness)).toBe(OLD_LABEL);
    expect(harness.collection.pendingKeys.size).toBe(0);
    // 1 次确认读 + 2 次重试读（§4.2 的默认 2 次）。
    expect(harness.fakeDatabase.calls.select).toBe(4);

    // 索引追上之后再写就成功（同一集合、同一协议）。
    harness.fakeDocument.holdWrites(false);
    harness.fakeDocument.flush();
    const retry = harness.collection.update('w1', (draft) => {
      draft.label = 'Finally';
    });
    await retry.isPersisted.promise;
    expect(labelOf(harness)).toBe('Finally');
  });

  it('rolls back and keeps the server value when someone else changed the row (conflict)', async () => {
    const conflicts: unknown[] = [];
    const local = createHarness({
      onConflict: (conflict) => conflicts.push(conflict),
    });
    await local.collection.preload();
    local.fakeDocument.holdWrites(true);

    const transaction = local.collection.update('w1', (draft) => {
      draft.label = 'Mine';
    });
    // 本地写还在飞时，别人把同一行改成别的值。
    local.fakeDocument.putRow('w1', {
      ...(local.fakeDocument.rows().get('w1') ?? {}),
      label: 'Theirs',
    });

    await expect(transaction.isPersisted.promise).rejects.toMatchObject({ code: 'write_conflict' });
    expect(transaction.state).toBe('failed');
    expect(local.collection.conflicts).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    const conflict = local.collection.conflicts[0];
    expect(conflict?.key).toBe('w1');
    expect(stripVirtualProps(conflict!.server).label).toBe('Theirs');
    // server wins：集合显示别人的值，而不是本地未确认的意图。
    expect(labelOf(local)).toBe('Theirs');
    expect(local.collection.pendingKeys.size).toBe(0);
  });

  it('rolls back when drizzle-solid rejects the write', async () => {
    harness.fakeDatabase.failNextWrite(new Error('server said no'));
    const transaction = harness.collection.update('w1', (draft) => {
      draft.label = 'Rejected';
    });
    await expect(transaction.isPersisted.promise).rejects.toThrow('server said no');
    expect(transaction.state).toBe('failed');
    expect(labelOf(harness)).toBe(OLD_LABEL);
    expect(harness.collection.pendingKeys.size).toBe(0);
  });

  it('fails the transaction when the array+uri PATCH is rejected', async () => {
    harness.fakeDatabase.failNextPatch(500);
    const transaction = harness.collection.update('w1', (draft) => {
      draft.hasModel = [`${harness.podUrl}settings/models/c.ttl#c`];
    });
    await expect(transaction.isPersisted.promise).rejects.toMatchObject({ code: 'write_field_rejected' });
    expect(transaction.state).toBe('failed');
    // 只有 PATCH，没有 ORM 写（§4.1：PATCH 是这次写的全部）。
    expect(harness.fakeDatabase.calls.updateById).toHaveLength(0);
    expect(harness.collection.pendingKeys.size).toBe(0);
  });

  it('keeps the pending key gated while the write is in flight', async () => {
    harness.fakeDocument.holdWrites(true);
    const transaction = harness.collection.update('w1', (draft) => {
      draft.label = 'InFlight';
    });
    await waitUntil(() => harness.collection.pendingKeys.has('w1'), 'key is marked pending');
    // 未确认的写期间，服务端行（旧值）不能把乐观行顶掉，也不能被当成「行已消失」。
    expect(labelOf(harness)).toBe('InFlight');
    await expect(transaction.isPersisted.promise).rejects.toMatchObject({ code: 'write_unconfirmed' });
    await tick(5);
    expect(harness.collection.pendingKeys.size).toBe(0);
  });
});

/**
 * §9-7 的确认规则：确认只能承诺读得回来的东西。
 *
 * `secret: true` 的字段不进投影（`mapSubjectRows()` 按 `writeOnlyFields()` 跳过），
 * 所以它们**不参与**覆盖比对、也不会把意图推向冲突分支；可读字段一个都不放过。
 * 这里直接驱动 `reconcilePendingWrites()`：不经过库与假数据库，规则本身是什么就是什么。
 */
describe('pod collection write confirmation and write-only fields', () => {
  type Row = { id: string; label?: string; apiKey?: string; secretType?: string };
  const fieldOrder = projectionFieldOrder(widgetDescriptor);
  const writeOnly = writeOnlyFields(widgetDescriptor);
  const hashOf = (row: Row): string => projectionHash(row, fieldOrder);

  function pendingWrite(intent: Row, beforeHash?: string) {
    const pending = createPendingWrites<Row>();
    const entry = pending.register({ key: intent.id, intent, localRow: intent, beforeHash });
    return { pending, entry };
  }

  it('excludes write-only fields from the projection the confirmation compares', () => {
    expect([...writeOnly]).toEqual(['apiKey']);
    const intent = { id: 'w1', label: 'Mine', apiKey: 'sk-secret' };
    const server = { id: 'w1', label: 'Mine' };
    // 规则本身：默认（没有只写字段集合）时逐字段全比 —— 这正是 §9-7 的旧缺陷，
    // 带上 writeOnly 之后 secret 不再参与比对。
    expect(projectionCovers(server, intent)).toBe(false);
    expect(projectionCovers(server, intent, writeOnly)).toBe(true);
  });

  it('confirms an intent whose only unreadable part is a write-only field', () => {
    const { pending, entry } = pendingWrite({ id: 'w1', label: 'Mine', apiKey: 'sk-secret' });
    // 服务端投影里没有 apiKey —— 它读不回来，不是冲突。
    reconcilePendingWrites(pending, new Map([['w1', { id: 'w1', label: 'Mine' }]]), hashOf, writeOnly);
    expect(entry.settled).toBe(true);
    expect(entry.error).toBeUndefined();
    expect(pending.conflicts).toHaveLength(0);
  });

  it('still reports a conflict when a readable field the intent carries is not on the server row', () => {
    const { pending, entry } = pendingWrite({ id: 'w1', label: 'Mine', apiKey: 'sk-secret' });
    // label 可读、也读得回来，服务端却没有它 —— 旧的守卫不许被 secret 规则削弱。
    reconcilePendingWrites(pending, new Map([['w1', { id: 'w1' }]]), hashOf, writeOnly);
    expect(entry.settled).toBe(true);
    expect(entry.error).toMatchObject({ code: 'write_conflict' });
    expect(pending.conflicts).toHaveLength(1);
  });

  it('still reports a conflict when a readable field differs from the intent', () => {
    const { pending, entry } = pendingWrite({ id: 'w1', label: 'Mine', apiKey: 'sk-secret' });
    reconcilePendingWrites(pending, new Map([['w1', { id: 'w1', label: 'Theirs' }]]), hashOf, writeOnly);
    expect(entry.error).toMatchObject({ code: 'write_conflict' });
  });

  it('treats an intent that carries only write-only fields as confirmed by the row being there', () => {
    const { pending, entry } = pendingWrite({ id: 'w4', apiKey: 'sk-only' });
    // 行还没出现：没有任何证据，继续等（不是确认，也不是冲突）。
    reconcilePendingWrites(pending, new Map(), hashOf, writeOnly);
    expect(entry.settled).toBe(false);
    // 行出现了（写入已经落盘）：可读部分只剩行标识，按「写入调用成功 + 行在」确认。
    reconcilePendingWrites(pending, new Map([['w4', { id: 'w4' }]]), hashOf, writeOnly);
    expect(entry.settled).toBe(true);
    expect(entry.error).toBeUndefined();
    expect(pending.conflicts).toHaveLength(0);
  });

  it('still treats a readable field that this layer cannot read back as unconfinable', () => {
    // `secretType` 是**可读**字段、但当前没有承载列（§2.7 的漂移面）：读不回来 ⇒ 不确认。
    const { pending, entry } = pendingWrite({ id: 'w5', secretType: 'api-key' });
    reconcilePendingWrites(pending, new Map([['w5', { id: 'w5' }]]), hashOf, writeOnly);
    expect(entry.error).toMatchObject({ code: 'write_conflict' });
  });
});

describe('pod collection inserts that carry write-only fields', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = createHarness();
    await harness.collection.preload();
  });

  it('confirms an insert whose intent carries a secret field and does not roll back', async () => {
    const transaction = harness.collection.insert({
      id: 'w3',
      label: 'Third',
      apiKey: 'sk-secret',
    });
    await transaction.isPersisted.promise;

    expect(transaction.state).toBe('completed');
    expect(harness.collection.conflicts).toHaveLength(0);
    expect(harness.collection.pendingKeys.size).toBe(0);
    // 行留下、可读字段在：写没有被回滚（旧缺陷下这里会 reject write_conflict）。
    expect(harness.collection.has('w3')).toBe(true);
    expect(labelOf(harness, 'w3')).toBe('Third');
    // 只写字段确实写进了文档（写入本身成功，是它的唯一证据），只是读不回来。
    expect(harness.fakeDocument.rows().get('w3')?.apiKey).toBe('sk-secret');
  });

  it('stays correct when only write-only fields are in the intent', async () => {
    const transaction = harness.collection.insert({ id: 'w4', apiKey: 'sk-only' });
    await transaction.isPersisted.promise;

    expect(transaction.state).toBe('completed');
    expect(harness.collection.conflicts).toHaveLength(0);
    expect(harness.collection.pendingKeys.size).toBe(0);
    expect(harness.collection.has('w4')).toBe(true);
    expect(harness.fakeDocument.rows().get('w4')?.apiKey).toBe('sk-only');
  });

  it('never confirms an insert whose readable field the server cannot return', async () => {
    // `secretType` 是可读字段、但没有承载列：意图带着它、服务端行永远不会有它 ⇒
    // 不确认（守卫没有被 secret 规则削弱），服务端赢，事务失败。
    const transaction = harness.collection.insert({ id: 'w5', secretType: 'api-key' });
    await expect(transaction.isPersisted.promise).rejects.toMatchObject({ code: 'write_conflict' });
    expect(transaction.state).toBe('failed');
    expect(harness.collection.conflicts).toHaveLength(1);
    expect(harness.collection.pendingKeys.size).toBe(0);
  });
});
