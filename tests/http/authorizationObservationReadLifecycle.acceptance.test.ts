import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { guardStream } from '@solid/community-server';
import { describe, expect, it, vi } from 'vitest';
import { guardedPolicyClosureFixture } from '../helpers/GuardedPolicyClosureFixture';

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
      timer = setTimeout(() => reject(new Error('Root source stream failure was not reached')), 2500);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

describe('actual authorization observation source teardown', () => {
  it.each(['error', 'early-close'] as const)('fails on source %s and waits for actual close before responding or unlocking', async mode => {
    await guardedPolicyClosureFixture(async f => {
      expect((await fetch(f.document, { method: 'HEAD' })).status).toBe(200);
      const request = await f.observationRequest();
      const physical = await f.accessor.getLocalRdfDocument({ path: f.document });
      physical.data.destroy();
      await finished(physical.data).catch(() => undefined);
      const failed = barrier(); const release = barrier();
      let started = false; let closeAcknowledged = false; let responseFinished = false;
      const stream = new Readable({
        read() {
          if (started) return;
          started = true; this.push(Buffer.from('<urn:root:partial> <urn:root:value> \"partial\" .\n'));
          queueMicrotask(() => this.destroy(mode === 'error' ? new Error('Root injected physical source read failure') : undefined));
        },
        destroy(error, callback) {
          failed.resolve();
          void release.promise.then(() => callback(error));
        },
      });
      stream.once('close', () => { closeAcknowledged = true; });
      const original = f.accessor.getLocalRdfDocument.bind(f.accessor);
      const data = vi.spyOn(f.accessor, 'getLocalRdfDocument').mockImplementation(async identifier =>
        identifier.path === f.document ? { data: guardStream(stream), metadata: physical.metadata } : await original(identifier));
      const responsePromise = f.post(request, media).then(response => { responseFinished = true; return response; });
      let writerFinished = false; let writer: Promise<unknown> | undefined;
      try {
        await reached(failed.promise);
        writer = f.locks.withWriteLock({ path: f.room }, () => { writerFinished = true; });
        await new Promise(resolve => setTimeout(resolve, 60));
        expect(responseFinished).toBe(false);
        expect(writerFinished).toBe(false);
        expect(closeAcknowledged).toBe(false);
        release.resolve();
        const response = await responsePromise;
        expect([500, 503]).toContain(response.status);
        expect(response.text).not.toContain('"read":');
        expect(closeAcknowledged).toBe(true);
        await writer;
        expect(writerFinished).toBe(true);
        expect(f.native).not.toHaveBeenCalled();
        data.mockRestore();
        expect((await f.post(await f.observationRequest(), media)).status).toBe(200);
      } finally {
        release.resolve();
        await responsePromise.catch(() => undefined);
        await writer?.catch(() => undefined);
        data.mockRestore();
      }
    }, { policyKind: 'acp', observation: {} });
  });
});
