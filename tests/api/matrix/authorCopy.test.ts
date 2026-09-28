import { describe, expect, it, vi } from 'vitest';
import { contentHashOf, verifyAgainstAuthorCopy } from '../../../src/api/matrix/authorCopy';
import { computeContentHash, encodeUnpaddedBase64 } from '../../../src/api/matrix/protocol/eventIntegrity';

const original = {
  event_id: '$one',
  room_id: '!room:alice.example',
  sender: 'https://alice.example/card#me',
  type: 'm.room.message',
  content: { body: 'hello' },
};

describe('confirming a copy against the author\'s own Pod', () => {
  it('accepts a copy that hashes like the original', async() => {
    const verdict = await verifyAgainstAuthorCopy({ roomId: '!room:alice.example', event: { ...original } },
      async() => ({ ...original }));
    expect(verdict).toEqual({ authentic: true, contentHash: contentHashOf(original) });
    // The hash is the shared rule, not a second implementation of it.
    // The hash is the same rule the stored event carries in `hashes.sha256`, not a second one.
    expect(contentHashOf(original)).toBe(encodeUnpaddedBase64(computeContentHash(original as never)));
  });

  it('refuses an edited copy, and says the author holds something else', async() => {
    const edited = { ...original, content: { body: 'hello there' } };
    const verdict = await verifyAgainstAuthorCopy({ roomId: '!room:alice.example', event: edited }, async() => ({ ...original }));
    expect(verdict.authentic).toBe(false);
    expect(verdict.authentic === false && verdict.reason).toBe('mismatch');
  });

  it('does not treat a missing original as acceptance', async() => {
    // Nothing to compare is not the same as agreement: an event the author's Pod never held cannot
    // be confirmed to be theirs.
    const verdict = await verifyAgainstAuthorCopy({ roomId: '!room:alice.example', event: { ...original } }, async() => undefined);
    expect(verdict.authentic).toBe(false);
    expect(verdict.authentic === false && verdict.reason).toBe('no-copy');
  });

  it('refuses an event with no id, and reports an unreadable Pod as such', async() => {
    const noId = await verifyAgainstAuthorCopy({ roomId: '!room:alice.example', event: { content: {} } }, async() => original);
    expect(noId.authentic === false && noId.reason).toBe('no-id');

    const unreadable = await verifyAgainstAuthorCopy({ roomId: '!room:alice.example', event: { ...original } },
      vi.fn(async() => { throw new Error('the Pod said 503'); }));
    expect(unreadable.authentic).toBe(false);
    expect(unreadable.authentic === false && unreadable.reason).toBe('unreadable');
    expect(unreadable.authentic === false && unreadable.detail).toContain('503');
  });

  it('asks the author about the room and id it was given, nothing else', async() => {
    const lookup = vi.fn(async() => original);
    await verifyAgainstAuthorCopy({ roomId: '!room:alice.example', event: { ...original } }, lookup);
    expect(lookup).toHaveBeenCalledWith('!room:alice.example', '$one');
  });
});
