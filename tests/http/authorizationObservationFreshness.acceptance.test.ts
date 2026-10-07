import { describe, expect, it } from 'vitest';
import { PermissionReader } from '@solid/community-server';
import { PERMISSIONS } from '@solidlab/policy-engine';
import { Parser } from 'n3';
import { expectedGroundDigest, guardedPolicyClosureFixture, rootAcpPolicy } from '../helpers/GuardedPolicyClosureFixture';

const media = 'application/vnd.xpod.authorization-observation+json';
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function reached(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Root discovery barrier was not reached')), 2500);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

describe('actual authorization observation discovery to fresh-lock race', () => {
  it('rereads a warmed missing global root policy after an actual deny writer completes before fresh locking', async () => {
    const entered = barrier(); const release = barrier();
    let target = ''; let document = ''; let room = ''; let paused = false; let armed = false;
    let locks: { hasHeldReadLock: (identifier: { path: string }) => boolean } | undefined;
    await guardedPolicyClosureFixture(async f => {
      target = `${f.pod}profile/bob#me`; document = f.document; room = f.room; locks = f.locks;
      await f.putRdfSet(f.podAcl, `${f.ownerPolicy}\n${rootAcpPolicy(f.podAcl, f.pod, target, ['Read'], { label: 'target' })}`);
      expect((await fetch(f.document, { method: 'HEAD', headers: { 'x-root-fixture-principal': target } })).status).toBe(200);
      armed = true;
      const responsePromise = f.post(await f.observationRequest(target), media);
      try {
        await reached(entered.promise);
        const rootPolicy = f.policyIri(f.origin);
        const denied = rootAcpPolicy(rootPolicy, f.origin, target, ['Read'], { deny: true, label: 'fresh-root-deny' });
        await f.putRdf(rootPolicy, denied);
        expect((await fetch(f.document, { method: 'HEAD', headers: { 'x-root-fixture-principal': target } })).status).toBe(403);
        release.resolve();
        const response = await responsePromise;
        expect(response.status, response.text).toBe(200);
        const result = JSON.parse(response.text);
        expect(result.read.every((row: { allowed: boolean }) => !row.allowed)).toBe(true);
        expect(result.guard.policies.find((row: { iri: string }) => row.iri === rootPolicy)).toEqual({
          iri: rootPolicy, kind: 'acp', state: 'present',
          digest: expectedGroundDigest(rootPolicy, new Parser({ baseIRI: rootPolicy }).parse(denied), 'acp'),
        });
        expect(f.native).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await responsePromise.catch(() => undefined);
      }
    }, { policyKind: 'acp', observation: {
      reader: actual => new class extends PermissionReader {
        public override async handle(input: Parameters<PermissionReader['handle']>[0]) {
          const result = await actual.handleSafe(input);
          if (armed && !paused && input.credentials.agent?.webId === target
            && input.requestedModes.hasEntry({ path: document }, PERMISSIONS.Read)
            && locks && !locks.hasHeldReadLock({ path: room })) {
            paused = true; entered.resolve(); await release.promise;
          }
          return result;
        }
      }(),
    } });
  });
});
