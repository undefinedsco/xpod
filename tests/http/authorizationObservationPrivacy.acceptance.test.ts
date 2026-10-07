import { describe, expect, it, vi } from 'vitest';
import { PermissionReader, type Credentials } from '@solid/community-server';
import { CachedHandler } from 'asynchronous-handlers';
import { guardedPolicyClosureFixture, rootAcpPolicy } from '../helpers/GuardedPolicyClosureFixture';

type CacheInput = { [K in keyof Parameters<PermissionReader['handle']>[0]]: Parameters<PermissionReader['handle']>[0][K] };
const media = 'application/vnd.xpod.authorization-observation+json';

describe('actual authorization observation routing and privacy', () => {
  it('preserves an ordinary custom route but refuses it before dispatch or room enumeration during observation', async () => {
    let calls = 0; let delegate: PermissionReader | undefined;
    const custom = new class extends PermissionReader {
      public override async canHandle(input: Parameters<PermissionReader['canHandle']>[0]) {
        calls++;
        if (!delegate) throw new Error('Root route delegate is not ready');
        await delegate.canHandle(input);
      }
      public override async handle(input: Parameters<PermissionReader['handle']>[0]) {
        calls++;
        if (!delegate) throw new Error('Root route delegate is not ready');
        return await delegate.handleSafe(input);
      }
    }();
    await guardedPolicyClosureFixture(async f => {
      expect((await fetch(f.document, { method: 'HEAD' })).status).toBe(200);
      expect(calls).toBeGreaterThan(0);
      calls = 0;
      const children = vi.spyOn(f.accessor, 'getChildren');
      const response = await f.post(await f.observationRequest(), media);
      expect(response.status).toBe(415);
      expect(calls).toBe(0);
      expect(children).not.toHaveBeenCalled();
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {
      routes: room => ({ [`^${new URL(room).pathname.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`]: custom }),
      reader: (actual, builtin) => { delegate = builtin; return actual; },
    } });
  });

  it('does not enumerate a requester-denied child container or disclose its identity despite room Control', async () => {
    await guardedPolicyClosureFixture(async f => {
      const target = `${f.pod}profile/bob#me`;
      await f.putRdfSet(f.podAcl, `${f.ownerPolicy}\n${rootAcpPolicy(f.podAcl, f.pod, target, ['Read'], { label: 'target' })}`);
      const hidden = `${f.room}hidden-private/`;
      const marker = `${hidden}private-marker.ttl`;
      await f.putContainer(hidden);
      await f.putRdf(marker, '<urn:root:private-marker> <urn:root:value> "hidden" .');
      const policy = f.policyIri(hidden);
      await f.putRdfSet(policy, `${rootAcpPolicy(policy, hidden, f.owner, ['Read'], { deny: true, label: 'owner-denied' })}\n${
        rootAcpPolicy(policy, hidden, target, ['Read'], { label: 'target' })}`);
      expect((await fetch(hidden, { method: 'HEAD' })).status).toBe(403);
      expect((await fetch(hidden, { method: 'HEAD', headers: { 'x-root-fixture-principal': target } })).status).toBe(200);
      const children = vi.spyOn(f.accessor, 'getChildren');
      f.native.mockClear();
      const response = await f.post(await f.observationRequest(target), media);
      expect(response.status).toBe(403);
      expect(children.mock.calls.some(([identifier]) => identifier.path === hidden)).toBe(false);
      expect(response.text).not.toContain(hidden);
      expect(response.text).not.toContain(marker);
      expect(response.text).not.toContain('"guard":');
      expect(response.text).not.toContain('"read":');
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {} });
  });

  it('refuses a capability bound to a different accessor object before enumerating even when it forwards identically', async () => {
    let enumeration = 0;
    await guardedPolicyClosureFixture(async f => {
      const response = await f.post(await f.observationRequest(), media);
      expect(response.status).toBe(415);
      expect(enumeration).toBe(0);
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {
      boundArgs: actual => {
        const changed = [...actual] as typeof actual;
        changed[3] = new Proxy(actual[3], { get: (target, property) => {
          const value = Reflect.get(target, property, target);
          if (typeof value !== 'function') return value;
          if (property === 'getChildren') return (...args: unknown[]) => {
            enumeration++;
            return value.apply(target, args);
          };
          return value.bind(target);
        } });
        return changed;
      },
    } });
  });
  it('retains requester client and issuer claims but evaluates target with fresh agent-only credentials', async () => {
    const captured: { credentials: Credentials }[] = [];
    const client = { clientId: 'https://root-fixture.example/client' };
    const issuer = { url: 'https://root-fixture.example/issuer' };
    await guardedPolicyClosureFixture(async f => {
      const target = `${f.pod}profile/bob#me`;
      await f.putRdfSet(f.podAcl, `${f.ownerPolicy}\n${rootAcpPolicy(f.podAcl, f.pod, target, ['Read'], { label: 'target' })}`);
      expect((await fetch(f.document, { method: 'HEAD', headers: { 'x-root-fixture-principal': target } })).status).toBe(200);
      captured.length = 0;
      const response = await f.post(await f.observationRequest(target), media);
      expect(response.status).toBe(200);
      const result = JSON.parse(response.text);
      const requesterCalls = captured.filter(call => call.credentials.agent?.webId === f.owner);
      const targetCalls = captured.filter(call => call.credentials.agent?.webId === target);
      expect(requesterCalls.length).toBeGreaterThan(0);
      expect(targetCalls.length).toBeGreaterThan(0);
      for (const call of requesterCalls) {
        expect(call.credentials.client).toEqual(client);
        expect(call.credentials.issuer).toEqual(issuer);
      }
      for (const call of targetCalls) {
        expect(call.credentials).toEqual({ agent: { webId: target } });
        expect(requesterCalls.some(requester => requester.credentials === call.credentials)).toBe(false);
      }
      expect(result.read.length).toBeGreaterThan(0);
      expect(result.read.every((entry: { allowed: boolean }) => entry.allowed)).toBe(true);
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {
      credentials: actual => ({ ...actual, client, issuer }),
      reader: actual => new class extends PermissionReader {
        public override async canHandle(input: Parameters<PermissionReader['canHandle']>[0]) {
          await actual.canHandle(input);
        }
        public override async handle(input: Parameters<PermissionReader['handle']>[0]) {
          captured.push({ credentials: input.credentials });
          return await actual.handleSafe(input);
        }
      }(),
    } });
  });

  it('works through the installed outer CachedHandler with production field keys on repeated observations', async () => {
    await guardedPolicyClosureFixture(async f => {
      for (let index = 0; index < 2; index++) {
        const response = await f.post(await f.observationRequest(), media);
        expect(response.status, `${response.text}; ${JSON.stringify(f.handlerErrors)}`).toBe(200);
        const result = JSON.parse(response.text);
        expect(result.read.every((row: { allowed: boolean }) => row.allowed)).toBe(true);
      }
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {
      reader: actual => new CachedHandler<CacheInput, Awaited<ReturnType<PermissionReader['handle']>>>(actual, ['credentials', 'requestedModes']),
    } });
  });

  it('preserves a target full WebID query and fragment without treating its query-free spelling as the same agent', async () => {
    await guardedPolicyClosureFixture(async f => {
      const target = `${f.pod}profile/bob-card?account=bob#me`;
      const different = `${f.pod}profile/bob-card#me`;
      await f.putRdfSet(f.podAcl, `${f.ownerPolicy}\n${rootAcpPolicy(f.podAcl, f.pod, target, ['Read'], { label: 'query-target' })}`);
      expect((await fetch(f.document, { method: 'HEAD', headers: { 'x-root-fixture-principal': target } })).status).toBe(200);
      expect((await fetch(f.document, { method: 'HEAD', headers: { 'x-root-fixture-principal': different } })).status).toBe(403);
      const response = await f.post(await f.observationRequest(target), media);
      expect(response.status, response.text).toBe(200);
      const result = JSON.parse(response.text);
      expect(result.targetWebId).toBe(target);
      expect(result.read.every((row: { allowed: boolean }) => row.allowed)).toBe(true);
      const other = await f.post(await f.observationRequest(different), media);
      expect(other.status).toBe(200);
      expect(JSON.parse(other.text).read.every((row: { allowed: boolean }) => !row.allowed)).toBe(true);
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {} });
  });

});
