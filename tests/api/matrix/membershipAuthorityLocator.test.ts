import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { getSqliteRuntime, type SqliteDatabase } from '../../../src/storage/SqliteRuntime';
import { MembershipAuthorityLocator } from '../../../src/api/matrix/membershipAuthorityLocator';
const opened: SqliteDatabase[] = [];
const dirs: string[] = [];
const source = 'https://pod.example/owner/.data/chat/room/index.ttl#this';
const candidate = { sourceIri: source, sourcePodId: 'pod-owner', sourceRoot: 'https://pod.example/owner/',
  ownerWebId: 'https://pod.example/owner/profile/card#me',
  binding: { purpose: 'membership' as const, credentialRef: 'taskcred_explicit', version: 1, issuer: 'https://issuer.example/' } };
function open(filename: string) {
  const runtime = getSqliteRuntime(); const raw = runtime.openDatabase(filename); opened.push(raw);
  return new MembershipAuthorityLocator(runtime.createDrizzleDatabase(raw));
}
afterEach(() => { for (const db of opened.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it('reopens exact nonsecret candidates and forgets only the requested source', async() => {
  mkdirSync('.test-data/sol-membership-locator', { recursive: true });
  const dir = mkdtempSync(path.resolve('.test-data/sol-membership-locator/own-')); dirs.push(dir);
  const filename = path.join(dir, 'locator.sqlite');
  const first = open(filename); await first.remember(candidate);
  await first.remember({ ...candidate, sourceIri: `${source}-other` });
  opened.pop()!.close(); const second = open(filename);
  expect(await second.find(source)).toEqual(candidate);
  await second.forget(source); expect(await second.find(source)).toBeUndefined();
  expect(await second.find(`${source}-other`)).toEqual({ ...candidate, sourceIri: `${source}-other` });
  await second.wipe(); expect(await second.find(`${source}-other`)).toBeUndefined();
});
it('refuses persisted payloads that could contain authority flags or secrets', async() => {
  const locator = open(':memory:');
  await expect(locator.remember({ ...candidate, passed: true } as never)).rejects.toThrow();
  await expect(locator.remember({ ...candidate, binding: { ...candidate.binding, clientSecret: 'fixture' } } as never)).rejects.toThrow();
  expect(await locator.find(source)).toBeUndefined();
});
