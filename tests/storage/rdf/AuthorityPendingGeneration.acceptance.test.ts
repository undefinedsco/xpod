// Public persistent-pending contract; this does not prove a file commit or process crash recovery.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RootedSolidFsSyncJournal } from '../../../src/solidfs/SolidFsSyncJournal';
import { hashAuthoritySource } from '../../../src/storage/AuthorityFreshnessService';

describe('Root: stale recovery cannot clear a later authority attempt', () => {
  it('gives identical-content attempts distinct tokens across actual journal connections', async () => {
    const parent = path.resolve('.test-data/authority-pending-generation');
    await mkdir(parent, { recursive: true });
    const fixture = await mkdtemp(path.join(parent, 'run-'));
    const root = path.join(fixture, 'data');
    const sourcePath = path.join(root, 'alice', 'messages.ttl');
    const workspace = { workspace: 'http://root.invalid/', cwd: root,
      projection: 'direct' as const, entries: [] };
    const change = { path: 'alice/messages.ttl', resource: 'http://root.invalid/alice/messages.ttl',
      sourcePath, source: 'filesystem' as const, projection: 'direct' as const,
      contentType: 'text/turtle', type: 'updated' as const };
    const version = hashAuthoritySource('<urn:message> <urn:value> "same bytes" .');
    const oldConnection = new RootedSolidFsSyncJournal(root);
    const currentConnection = new RootedSolidFsSyncJournal(root);
    try {
      const old = oldConnection.recordAuthorityPending(change, workspace, version);
      const current = currentConnection.recordAuthorityPending(change, workspace, version);
      expect.soft(current.id, 'equal intended bytes do not identify a write attempt').not.toBe(old.id);
      oldConnection.clearAuthorityPending(old.id);
      expect(currentConnection.getAuthorityPending(current.id)?.id).toBe(current.id);
    } finally {
      oldConnection.close();
      currentConnection.close();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('keeps a later token persistent when an older token is cleared after reopen', async () => {
    const parent = path.resolve('.test-data/authority-pending-generation');
    await mkdir(parent, { recursive: true });
    const fixture = await mkdtemp(path.join(parent, 'run-'));
    const root = path.join(fixture, 'data');
    const workspace = { workspace: 'http://root.invalid/', cwd: root,
      projection: 'direct' as const, entries: [] };
    const change = { path: 'alice/messages.ttl', resource: 'http://root.invalid/alice/messages.ttl',
      sourcePath: path.join(root, 'alice', 'messages.ttl'), source: 'filesystem' as const,
      projection: 'direct' as const, contentType: 'text/turtle', type: 'updated' as const };
    let connection: RootedSolidFsSyncJournal | undefined;
    try {
      connection = new RootedSolidFsSyncJournal(root);
      const old = connection.recordAuthorityPending(change, workspace, hashAuthoritySource('old'));
      const current = connection.recordAuthorityPending(change, workspace, hashAuthoritySource('new'));
      connection.close();
      connection = new RootedSolidFsSyncJournal(root);
      expect(connection.getAuthorityPending(current.id)?.id).toBe(current.id);
      expect(connection.clearAuthorityPending(old.id)).toBe(true);
      expect(connection.getAuthorityPending(current.id)?.id).toBe(current.id);
    } finally {
      connection?.close();
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
