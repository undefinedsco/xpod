import { test } from 'vitest';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { cleanupOwnedHostGroup, closeOwnedHost, hostGroupPassed, ownedHostGroupAbsent, recordOwnedHost, type OwnedHostGroup } from './ownedElectronHost';

test('actual detached host exit/close and group absence are required together', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),100)'], { detached: true, stdio: 'ignore' });
  const host = { process: () => child, close: async () => {
    if (child.exitCode === null) await new Promise<void>(resolve => child.once('close', () => resolve()));
  } };
  const record = recordOwnedHost(host);
  try {
    await closeOwnedHost(host, record);
    assert.equal(hostGroupPassed(record), true);
    assert.equal(record.groupAbsent, true);
    assert.equal(record.closeObserved, true);
  } finally { await cleanupOwnedHostGroup(record); }
});

test('exit zero with a remaining real group cannot pass; only that owned group is cleaned', async () => {
  const code = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});c.unref();setTimeout(()=>process.exit(0),100);`;
  const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' });
  const host = { process: () => child, close: async () => {
    if (child.exitCode === null) await new Promise<void>(resolve => child.once('close', () => resolve()));
  } };
  const record = recordOwnedHost(host);
  try {
    await assert.rejects(closeOwnedHost(host, record), /lifecycle incomplete/);
    assert.equal(record.exitCode, 0);
    assert.equal(record.closeObserved, true);
    assert.equal(record.forcedCleanup, true);
    assert.equal(hostGroupPassed(record), false);
    console.log(JSON.stringify({ kind: 'owned-host-exit-zero-residual-group-negative', record }));
  } finally { await cleanupOwnedHostGroup(record); }
});

test('EPERM never means group absence', () => {
  const record = { pid: 123, ownershipUnknown: false } as OwnedHostGroup;
  const original = process.kill;
  try {
    process.kill = (() => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); }) as typeof process.kill;
    assert.equal(ownedHostGroupAbsent(record), false);
    assert.equal(record.ownershipUnknown, true);
  } finally { process.kill = original; }
});

test('startup observer counts real grant/password shapes without retaining bodies or tokens', () => {
  const { observeRequest } = createRequire(import.meta.url)('./desktopSessionObserver.cjs');
  const state = { authorizationCodes: 0, passwordPosts: 0, refreshTokens: 0, opaquePosts: 0 };
  const issuer = 'http://localhost:49102/';
  for (const [url, body] of [
    ['.oidc/token', 'grant_type=authorization_code&code=DO-NOT-EXPORT'],
    ['.oidc/token', 'grant_type=refresh_token&refresh_token=DO-NOT-EXPORT'],
    ['.account/interaction/owned/login/password/', 'email=private&password=DO-NOT-EXPORT'],
  ]) observeRequest(state, { method: 'POST', url: new URL(url, issuer).href,
    uploadData: [{ bytes: Buffer.from(body) }] }, issuer);
  assert.deepEqual(state, { authorizationCodes: 1, passwordPosts: 1, refreshTokens: 1, opaquePosts: 0 });
  assert.equal(JSON.stringify(state).includes('DO-NOT-EXPORT'), false);
  observeRequest(state, { method: 'POST', url: new URL('.oidc/token', issuer).href, uploadData: [{ file: '/private' }] }, issuer);
  assert.equal(state.opaquePosts, 1);
});
