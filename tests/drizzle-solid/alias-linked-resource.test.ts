import { describe, expect, it } from 'vitest';
import { alias } from '@undefineds.co/drizzle-solid';
import { messageResource } from '@undefineds.co/models';

describe('public alias over linked models resources', () => {
  it('clones the Message columns while preserving each linked schema identity', () => {
    const originalOwners = new Map(Object.keys(messageResource.columns).map(name => [ name, messageResource.getColumn(name)!.table ]));
    const cloned = alias(messageResource, 'linked_messages');
    for (const name of Object.keys(messageResource.columns)) {
      const column = messageResource.getColumn(name)!;
      const aliased = cloned.getColumn(name)!;
      expect(aliased).not.toBe(column);
      expect(aliased.table).toBe(cloned);
      expect(aliased.options.linkTable).toBe(column.options.linkTable);
      expect(column.table).toBe(originalOwners.get(name));
    }
    expect(cloned.getMapping()).toMatchObject({ type: messageResource.getType() });
  });

  it('can scope the cloned schema to a document without rebinding shared columns', () => {
    const originalOwner = messageResource.createdAt.table;
    const cloned = alias(messageResource, 'document_messages');
    const document = 'https://pod.example/alice/.data/chat/one/2026/10/03/messages.ttl';
    const scoped = cloned.$schema.table('document_messages', {
      base: document, resourceMode: 'ldp', autoRegister: false,
    });
    expect(scoped.getResourcePath()).toBe(document);
    expect(scoped.createdAt.table).toBe(scoped);
    expect(messageResource.createdAt.table).toBe(originalOwner);
    expect(scoped.chat.options.linkTable).toBe(messageResource.chat.options.linkTable);
  });
});
