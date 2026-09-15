import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { AppRunner, type App } from '@solid/community-server';
import { expect, it, vi } from 'vitest';
import { getFreePort } from '../../src/runtime/port-finder';

// Real CSS HTTP routes and password/token stores. Only outbound mail delivery
// is captured; this does not test SMTP or the Xpod Gateway transport.
it('recovers an Account password once and rejects old passwords, replay, tampered and expired tokens', async () => {
  await mkdir(path.resolve('.test-data'), { recursive: true });
  const root = await mkdtemp(path.resolve('.test-data/password-recovery-'));
  const port = await getFreePort(30_000 + Math.floor(Math.random() * 20_000), '127.0.0.1');
  const origin = `http://localhost:${port}`;
  const deliveries: Array<{ recipient: string; text: string }> = [];
  const runner = new AppRunner();
  const createManager = runner.createComponentsManager.bind(runner);
  runner.createComponentsManager = async (...args) => {
    const manager = await createManager(...args);
    const sender = await manager.instantiate('urn:solid-server:default:EmailSender') as unknown as {
      handleSafe: (mail: { recipient: string; text: string }) => Promise<void>;
    };
    sender.handleSafe = async (mail) => { deliveries.push(mail); };
    return manager;
  };
  let app: App | undefined;
  const post = (route: string, body: object, authorization?: string) => fetch(new URL(route, origin), {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(authorization ? { Authorization: `CSS-Account-Token ${authorization}` } : {}) },
    body: JSON.stringify(body),
  });
  try {
    app = await runner.create({ shorthand: { port, baseUrl: `${origin}/`, rootFilePath: root, loggingLevel: 'off' } });
    await app.start();
    const email = 'password-recovery@example.test';
    const password = 'initial-password-123';
    const nextPassword = 'replacement-password-456';
    const created = await post('/.account/account/', {});
    expect(created.ok).toBe(true);
    const account = await created.json() as { authorization: string };
    expect(typeof account.authorization).toBe('string');
    const controlsResponse = await fetch(`${origin}/.account/`, { headers: { Accept: 'application/json', Authorization: `CSS-Account-Token ${account.authorization}` } });
    expect(controlsResponse.ok).toBe(true);
    const controls = await controlsResponse.json() as { controls: { password: { create: string } } };
    const registered = await post(controls.controls.password.create, { email, password }, account.authorization);
    expect(registered.ok).toBe(true);
    expect((await post('/.account/login/password/', { email, password })).ok).toBe(true);

    const forgot = await post('/.account/login/password/forgot/', { email });
    expect(forgot.ok).toBe(true);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].recipient).toBe(email);
    const resetLink = deliveries[0].text.match(/https?:\/\/\S+/u)?.[0];
    expect(resetLink).toBeTruthy();
    const resetUrl = new URL(resetLink!);
    expect(resetUrl.origin).toBe(origin);
    const recordId = resetUrl.searchParams.get('rid');
    expect(recordId).toBeTruthy();
    const reset = await post(resetUrl.pathname, { recordId, password: nextPassword });
    expect(reset.ok).toBe(true);
    expect((await post('/.account/login/password/', { email, password: nextPassword })).ok).toBe(true);
    expect((await post('/.account/login/password/', { email, password })).status).toBe(403);
    expect((await post(resetUrl.pathname, { recordId, password })).status).toBe(400);
    expect((await post('/.account/login/password/', { email, password: nextPassword })).ok).toBe(true);

    const tampered = await post(resetUrl.pathname, { recordId: `${recordId}-tampered`, password });
    expect(tampered.status).toBe(400);
    expect((await post('/.account/login/password/', { email, password: nextPassword })).ok).toBe(true);

    const renewed = await post('/.account/login/password/forgot/', { email });
    expect(renewed.ok).toBe(true);
    expect(deliveries).toHaveLength(2);
    const expiringLink = deliveries[1].text.match(/https?:\/\/\S+/u)?.[0];
    expect(expiringLink).toBeTruthy();
    const expiringUrl = new URL(expiringLink!);
    const expiringRecordId = expiringUrl.searchParams.get('rid');
    expect(expiringRecordId).toBeTruthy();
    expect(expiringRecordId).not.toBe(recordId);
    // CSS BaseForgotPasswordStore defaults to 15 minutes; password.json does
    // not override it. WrappedExpiringStorage checks Date when reading the
    // record. Leave socket/timer machinery real and restore Date locally.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(Date.now() + 16 * 60 * 1000));
      expect((await post(expiringUrl.pathname, { recordId: expiringRecordId, password })).status).toBe(400);
    } finally {
      vi.useRealTimers();
    }
    // Expiry deletes the record, so moving the test clock back cannot revive it.
    expect((await post(expiringUrl.pathname, { recordId: expiringRecordId, password })).status).toBe(400);
    expect((await post('/.account/login/password/', { email, password: nextPassword })).ok).toBe(true);

    const unknown = await post('/.account/login/password/forgot/', { email: 'unknown@example.test' });
    expect(unknown.status).toBe(forgot.status);
    expect(deliveries).toHaveLength(2);
  } finally {
    await app?.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
