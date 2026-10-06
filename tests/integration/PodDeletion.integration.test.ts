import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { XpodTestStack } from '../helpers/XpodTestStack';
import { setupAccount, loginWithClientCredentials } from './helpers/solidAccount';
import { getSqliteRuntime } from '../../src/storage/SqliteRuntime';

// Real isolated Gateway/CSS/API and SQLite/file storage. XpodTestStack uses its
// established fake QLever subprocess; this does not claim native SPARQL acceptance.
it.skipIf(process.env.XPOD_RUN_INTEGRATION_TESTS !== 'true')('deletes a standalone Local Pod and a same-name recreation while preserving another Pod and the Account', async () => {
  await mkdir(path.resolve('.test-data'), { recursive: true });
  const root = await mkdtemp(path.resolve('.test-data/pod-deletion-'));
  const stack = new XpodTestStack();
  const rdfIndexPath = path.join(root, 'rdf-index.sqlite');
  const sqlite = getSqliteRuntime();
  const facts = (storageUrl: string): { sources: number; quads: number; mirroredQuads: number } => {
    const db = sqlite.openDatabase(rdfIndexPath, { readonly: true });
    const mirrorPath = path.join(root, 'quadstore.sqlite');
    // Standalone CSS creation does not need the API provisioning mirror.
    const mirror = existsSync(mirrorPath) ? sqlite.openDatabase(mirrorPath, { readonly: true }) : undefined;
    try {
      return {
        sources: db.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM rdf_sources WHERE source LIKE ?').get(`${storageUrl}%`)!.count,
        quads: db.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM rdf_quads q JOIN rdf_terms t ON t.id = q.graph_id WHERE t.value LIKE ?').get(`${storageUrl}%`)!.count,
        mirroredQuads: mirror?.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM quints WHERE graph LIKE ?').get(`${storageUrl}%`)!.count ?? 0,
      };
    } finally { db.close(); mirror?.close(); }
  };
  try {
    await stack.start('local', { runtimeRoot: root, rdfIndexPath, transport: 'port', logLevel: 'warn' });
    const account = await setupAccount(stack.baseUrl, 'delete-pod');
    expect(account).toBeTruthy();
    const session = await loginWithClientCredentials(account!);
    const kept = await setupAccount(stack.baseUrl, 'keep-pod');
    expect(kept).toBeTruthy();
    const keptSession = await loginWithClientCredentials(kept!);
    const keptDocument = new URL('keep.ttl', kept!.podUrl).href;
    expect((await keptSession.fetch(keptDocument, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: '<#kept> <https://example.test/name> "keep this Pod" .' })).ok).toBe(true);
    const headers = { accept: 'application/json', 'content-type': 'application/json' };
    const login = await fetch(new URL('.account/login/password/', stack.baseUrl), {
      method: 'POST', headers, body: JSON.stringify({ email: account!.email, password: account!.password }),
    });
    expect(login.ok).toBe(true);
    const cookies = login.headers.getSetCookie().map((cookie) => cookie.split(';', 1)[0]).join('; ');
    expect(cookies).toContain('css-account=');
    const accountHeaders = { accept: 'application/json', cookie: cookies };
    const indexResponse = await fetch(new URL('.account/', stack.baseUrl), { headers: accountHeaders });
    const indexText = await indexResponse.text();
    expect(indexResponse.status, indexText).toBe(200);
    const index = JSON.parse(indexText) as { controls: { account: { pod: string } } };
    const inventoryUrl = index.controls.account.pod;
    const inventory = await fetch(inventoryUrl, { headers: accountHeaders }).then((r) => r.json()) as { pods: Record<string, string>; podDeletionControls: Record<string, string> };
    expect(inventory.podDeletionControls[account!.podUrl]).toBe(inventory.pods[account!.podUrl]);
    const control = inventory.podDeletionControls[account!.podUrl];
    const nested = new URL('nested/', account!.podUrl).href;
    const binary = new URL('nested/file.bin', account!.podUrl).href;
    const rdf = new URL('nested/data.ttl', account!.podUrl).href;
    const acl = new URL('.acl', nested).href;
    expect((await session.fetch(nested, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: '' })).ok).toBe(true);
    expect((await session.fetch(binary, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array([0, 1, 2, 255]) })).ok).toBe(true);
    expect((await session.fetch(rdf, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: '<#thing> <https://example.test/name> "deletion" .' })).ok).toBe(true);
    expect((await session.fetch(acl, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: `@prefix acl: <http://www.w3.org/ns/auth/acl#>. <#owner> a acl:Authorization; acl:agent <${account!.webId}>; acl:accessTo <${nested}>; acl:default <${nested}>; acl:mode acl:Read, acl:Write, acl:Control.` })).ok).toBe(true);
    expect((await session.fetch(binary)).ok).toBe(true);
    expect(facts(account!.podUrl).sources).toBeGreaterThan(0);
    expect(facts(account!.podUrl).quads).toBeGreaterThan(0);
    const keptFacts = facts(kept!.podUrl);
    expect((await fetch(control, { method: 'DELETE', headers })).status).toBeGreaterThanOrEqual(400);
    const deletion = await fetch(control, { method: 'DELETE', headers: accountHeaders });
    expect(await deletion.text()).toContain('success');
    expect(deletion.ok).toBe(true);
    const after = await fetch(inventoryUrl, { headers: accountHeaders }).then((r) => r.json()) as { pods: Record<string, string> };
    expect(after.pods).not.toHaveProperty(account!.podUrl);
    expect(facts(account!.podUrl)).toEqual({ sources: 0, quads: 0, mirroredQuads: 0 });
    const podName = new URL(account!.podUrl).pathname.split('/').filter(Boolean).pop()!;
    await expect(stat(path.join(root, 'data', podName))).rejects.toMatchObject({ code: 'ENOENT' });
    for (const resource of [binary, rdf, acl, nested, account!.podUrl]) {
      expect((await session.fetch(resource)).status).toBe(404);
    }
    expect(facts(kept!.podUrl)).toEqual(keptFacts);
    expect(await (await keptSession.fetch(keptDocument)).text()).toContain('keep this Pod');
    const relogin = await fetch(new URL('.account/login/password/', stack.baseUrl), {
      method: 'POST', headers, body: JSON.stringify({ email: account!.email, password: account!.password }),
    });
    expect(relogin.ok).toBe(true);
    const recreated = await fetch(inventoryUrl, {
      method: 'POST', headers: { ...accountHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ name: podName }),
    });
    expect(recreated.ok, await recreated.clone().text()).toBe(true);
    const nextInventory = await fetch(inventoryUrl, { headers: accountHeaders }).then((r) => r.json()) as { podDeletionControls: Record<string, string> };
    const nextControl = nextInventory.podDeletionControls[account!.podUrl];
    expect(nextControl).toBeTruthy();
    expect(nextControl).not.toBe(control);
    const nextRdf = new URL('new.ttl', account!.podUrl).href;
    expect((await session.fetch(nextRdf, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: '<#new> <https://example.test/name> "new generation" .' })).ok).toBe(true);
    expect(facts(account!.podUrl).sources).toBeGreaterThan(0);
    const stale = await fetch(control, { method: 'DELETE', headers: accountHeaders });
    expect(stale.ok).toBe(true); // Original completed command is idempotent; it must leave the new Pod alone.
    expect((await session.fetch(nextRdf)).ok).toBe(true);
    const secondDeletion = await fetch(nextControl, { method: 'DELETE', headers: accountHeaders });
    expect(secondDeletion.ok, await secondDeletion.clone().text()).toBe(true);
    expect(facts(account!.podUrl)).toEqual({ sources: 0, quads: 0, mirroredQuads: 0 });
    await expect(stat(path.join(root, 'data', podName))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await session.fetch(nextRdf)).status).toBe(404);
    expect(facts(kept!.podUrl)).toEqual(keptFacts);
  } finally { await stack.stop(); await rm(root, { recursive: true, force: true }); }
}, 180_000);
