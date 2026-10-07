import { describe, expect, it } from 'vitest';
import { PermissionReader } from '@solid/community-server';
import { guardedPolicyClosureFixture, rootAcpPolicy } from '../helpers/GuardedPolicyClosureFixture';

const media = 'application/vnd.xpod.authorization-observation+json';
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function enteredWithin(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Root fresh-read barrier was not reached')), 2500);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

describe('actual authorization observation shared lock lifetime', () => {
  it.each(['policy', 'topology'] as const)('blocks an actual %s writer until fresh observation completes', async kind => {
    const entered = barrier(); const release = barrier();
    let actualLocks: { hasHeldReadLock: (identifier: { path: string }) => boolean } | undefined;
    let dependency = ''; let target = ''; let paused = false;
    await guardedPolicyClosureFixture(async f => {
      actualLocks = f.locks; dependency = f.pod; target = `${f.pod}profile/bob#me`;
      await f.putRdfSet(f.podAcl, `${f.ownerPolicy}\n${rootAcpPolicy(f.podAcl, f.pod, target, ['Read'], { label: 'target' })}`);
      const newHistory = `${f.room}2020/old-history.ttl`;
      if (kind === 'topology') await f.putContainer(`${f.room}2020/`);
      const request = await f.observationRequest(target);
      const responsePromise = f.post(request, media);
      let writer: Promise<unknown> | undefined;
      let writerFinished = false;
      try {
        try { await enteredWithin(entered.promise); }
        catch (error) {
          const response = await responsePromise;
          throw new Error(`${String(error)}; HTTP ${response.status}: ${response.text}; ${JSON.stringify(f.handlerErrors)}`);
        }
        writer = (kind === 'policy'
          ? f.putRdfSet(f.podAcl, `${f.ownerPolicy}\n${rootAcpPolicy(f.podAcl, f.pod, target, ['Read'], { deny: true, label: 'target-denied' })}`)
          : f.putRdf(newHistory, '<urn:root:old> <urn:root:value> "historic" .'))
          .then(() => { writerFinished = true; });
        await new Promise(resolve => setTimeout(resolve, 60));
        expect(writerFinished).toBe(false);
        release.resolve();
        const response = await responsePromise;
        expect(response.status).toBe(200);
        const result = JSON.parse(response.text);
        expect(result.read.every((row: { allowed: boolean }) => row.allowed)).toBe(true);
        expect(result.guard.resources.some((row: { iri: string }) => row.iri === newHistory)).toBe(false);
        await writer;
        expect(writerFinished).toBe(true);
        if (kind === 'policy') {
          expect((await fetch(f.document, { method: 'HEAD', headers: { 'x-root-fixture-principal': target } })).status).toBe(403);
        } else {
          const next = await f.post(await f.observationRequest(target), media);
          expect(next.status).toBe(200);
          expect(JSON.parse(next.text).guard.resources.some((row: { iri: string }) => row.iri === newHistory)).toBe(true);
        }
        expect(f.native).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await responsePromise.catch(() => undefined);
        await writer?.catch(() => undefined);
      }
    }, { policyKind: 'acp', observation: {
      reader: actual => new class extends PermissionReader {
        public override async handle(input: Parameters<PermissionReader['handle']>[0]) {
          const result = await actual.handleSafe(input);
          if (!paused && input.credentials.agent?.webId === target
            && actualLocks?.hasHeldReadLock({ path: dependency })) {
            paused = true; entered.resolve(); await release.promise;
          }
          return result;
        }
      }(),
    } });
  });
});
