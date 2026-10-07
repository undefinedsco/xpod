import { describe, expect, it } from 'vitest';
import { ForbiddenHttpError, PermissionReader } from '@solid/community-server';
import { PERMISSIONS } from '@solidlab/policy-engine';
import { guardedPolicyClosureFixture, rootAcpPolicy } from '../helpers/GuardedPolicyClosureFixture';

const media = 'application/vnd.xpod.authorization-observation+json';

describe('actual authorization observation per-call dispatch', () => {
  it('does not let requester room Control traversal certify later requester room Read bypass', async () => {
    let room = ''; let owner = ''; let armed = false; let bypassCalls = 0;
    await guardedPolicyClosureFixture(async f => {
      room = f.room; owner = f.owner;
      const target = `${f.pod}profile/bob#me`;
      await f.putRdfSet(f.podAcl, `${f.ownerPolicy}\n${rootAcpPolicy(f.podAcl, f.pod, target, ['Read'], { label: 'target' })}`);
      expect((await fetch(f.document, { method: 'HEAD' })).status).toBe(200);
      expect((await fetch(f.document, { method: 'HEAD', headers: { 'x-root-fixture-principal': target } })).status).toBe(200);
      armed = true;
      const response = await f.post(await f.observationRequest(target), media);
      expect(bypassCalls, `HTTP ${response.status}: ${response.text}; ${JSON.stringify(f.handlerErrors)}`).toBeGreaterThan(0);
      expect(response.status).toBe(415);
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {
      reader: (actual, builtin) => new class extends PermissionReader {
        public override async handle(input: Parameters<PermissionReader['handle']>[0]) {
          if (armed && input.credentials.agent?.webId === owner
            && input.requestedModes.hasEntry({ path: room }, PERMISSIONS.Read)) {
            bypassCalls++;
            return await builtin.handleSafe(input);
          }
          return await actual.handleSafe(input);
        }
      }(),
    } });
  });

  it('fails the complete observation when target reader throws Forbidden after completing actual dispatch', async () => {
    let target = ''; let armed = false; let faults = 0;
    await guardedPolicyClosureFixture(async f => {
      target = `${f.pod}profile/bob#me`;
      await f.putRdfSet(f.podAcl, `${f.ownerPolicy}\n${rootAcpPolicy(f.podAcl, f.pod, target, ['Read'], { label: 'target' })}`);
      expect((await fetch(f.document, { method: 'HEAD', headers: { 'x-root-fixture-principal': target } })).status).toBe(200);
      armed = true;
      const response = await f.post(await f.observationRequest(target), media);
      expect(faults).toBeGreaterThan(0);
      expect([500, 503]).toContain(response.status);
      expect(response.text).not.toContain('"read":');
      expect(f.native).not.toHaveBeenCalled();
    }, { policyKind: 'acp', observation: {
      reader: actual => new class extends PermissionReader {
        public override async handle(input: Parameters<PermissionReader['handle']>[0]) {
          const result = await actual.handleSafe(input);
          if (armed && input.credentials.agent?.webId === target) {
            faults++;
            throw new ForbiddenHttpError('Root injected reader failure after qualified traversal');
          }
          return result;
        }
      }(),
    } });
  });
});
