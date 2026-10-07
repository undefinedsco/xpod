import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { guardStream, RepresentationMetadata, type DataAccessor } from '@solid/community-server';
import { MixDataAccessor } from '../../../src/storage/accessors/MixDataAccessor';
import { withLockLease, type LockLeaseGuard } from '../../../src/storage/locking/LockExecutionContext';

const identifier = { path: 'https://lock.invalid/pod/messages.ttl' };
function lease(): LockLeaseGuard & { lose: () => void } {
  const owner: LockLeaseGuard & { lose: () => void } = {
    assertOwned: async() => { if (owner.failure) throw owner.failure; },
    lose: () => {
      owner.failure = new Error('Lease lost');
      owner.onLoss?.(owner.failure);
    },
  };
  return owner;
}
function fixture() {
  const structured = {
    prepareSparqlUpdate: vi.fn(), writeMetadata: vi.fn(), writeContainer: vi.fn(),
    deleteResource: vi.fn(), getMetadata: vi.fn(),
  };
  const files = { writeDocument: vi.fn(), writeContainer: vi.fn() };
  return { structured, files, accessor: new MixDataAccessor(
    structured as unknown as DataAccessor, files as unknown as DataAccessor,
  ) };
}

describe('MixDataAccessor lease boundaries', () => {
  it('rejects a lost owner before native prepare starts', async() => {
    const { accessor, structured } = fixture();
    const owner = lease();
    await expect(withLockLease(owner, async() => {
      owner.lose();
      await accessor.executeSparqlUpdate('INSERT DATA {}', identifier.path);
    })).rejects.toThrow('Lease lost');
    expect(structured.prepareSparqlUpdate).not.toHaveBeenCalled();
  });

  it.each([ 'lease', 'request' ])('passes %s cancellation into prepare and waits for its cleanup', async source => {
    const { accessor, structured, files } = fixture();
    const owner = lease();
    const request = new AbortController();
    let settled = false;
    structured.prepareSparqlUpdate.mockImplementation(async(_query, _base, _scope, options) => {
      expect(options.timeoutMs).toBe(123);
      expect(options.signal).toBeDefined();
      const canceled = new Promise<void>(done => options.signal.addEventListener('abort', () => done(), { once: true }));
      if (source === 'lease') owner.lose();
      else request.abort(new Error('Request canceled'));
      await canceled;
      await new Promise(done => setTimeout(done, 5));
      settled = true;
      throw options.signal.reason;
    });
    await expect(withLockLease(owner, () => accessor.executeSparqlUpdate(
      'INSERT DATA {}', identifier.path, undefined, { timeoutMs: 123, signal: request.signal },
    ))).rejects.toThrow(source === 'lease' ? 'Lease lost' : 'Request canceled');
    expect(settled).toBe(true);
    expect(files.writeDocument).not.toHaveBeenCalled();
  });

  it('rejects metadata and container writes after known loss', async() => {
    const { accessor, structured, files } = fixture();
    const owner = lease();
    await expect(withLockLease(owner, async() => {
      owner.lose();
      await expect(accessor.writeMetadata(identifier, new RepresentationMetadata(identifier))).rejects.toThrow('Lease lost');
      await expect(accessor.writeContainer(identifier, new RepresentationMetadata(identifier))).rejects.toThrow('Lease lost');
    })).rejects.toThrow('Lease lost');
    expect(structured.writeMetadata).not.toHaveBeenCalled();
    expect(structured.writeContainer).not.toHaveBeenCalled();
    expect(files.writeContainer).not.toHaveBeenCalled();
  });

  it('rejects file writes after known loss', async() => {
    const { accessor, files } = fixture();
    const owner = lease();
    const metadata = new RepresentationMetadata(identifier);
    metadata.contentType = 'text/plain';
    await expect(withLockLease(owner, async() => {
      owner.lose();
      await accessor.writeDocument(identifier, guardStream(Readable.from([ 'body' ])), metadata);
    })).rejects.toThrow('Lease lost');
    expect(files.writeDocument).not.toHaveBeenCalled();
  });
});
