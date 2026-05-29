import { describe, expect, it, vi } from 'vitest';
import {
  currentStorageScope,
  lookupProvisionScopedWebIds,
  scopedEntriesFromPods,
  storageModeFor,
  storageUrlBelongsToRoot,
} from '../../ui/src/utils/storage-scope';

describe('storage scope helpers', () => {
  it('treats provider roots as prefixes for user Pods', () => {
    expect(storageUrlBelongsToRoot('https://id.example/alice/', 'https://id.example/')).toBe(true);
    expect(storageUrlBelongsToRoot('https://id.example/alice/settings/', 'https://id.example/')).toBe(true);
    expect(storageUrlBelongsToRoot('https://node.example/alice/', 'https://id.example/')).toBe(false);
  });

  it('treats path scoped providers as prefixes without leaking siblings', () => {
    expect(storageUrlBelongsToRoot('https://sp.example/team/alice/', 'https://sp.example/team/')).toBe(true);
    expect(storageUrlBelongsToRoot('https://sp.example/team2/alice/', 'https://sp.example/team/')).toBe(false);
  });

  it('marks Cloud WebID plus Local SP storage as local', () => {
    expect(storageModeFor(
      'https://id.example/alice/profile/card#me',
      'https://id.example/alice/',
    )).toBe('cloud');
    expect(storageModeFor(
      'https://id.example/alice/profile/card#me',
      'https://node-0000.undefineds.co/alice/',
    )).toBe('local');
  });

  it('builds Cloud scoped entries from same-provider Pods', () => {
    expect(scopedEntriesFromPods(
      [
        'https://id.example/alice/profile/card#me',
        'https://other.example/bob/profile/card#me',
      ],
      [
        'https://id.example/alice/',
        'https://node-0000.undefineds.co/alice/',
      ],
      { root: 'https://id.example/', mode: 'cloud' },
    )).toEqual([
      {
        webId: 'https://id.example/alice/profile/card#me',
        storageUrl: 'https://id.example/alice/',
        storageMode: 'cloud',
      },
    ]);
  });

  it('builds Local scoped entries from provisioned SP Pods', () => {
    expect(scopedEntriesFromPods(
      [
        'https://id.example/alice/profile/card#me',
        'https://id.example/bob/profile/card#me',
      ],
      [
        'https://id.example/alice/',
        'https://node-0000.undefineds.co/alice/',
      ],
      { root: 'https://node-0000.undefineds.co/', mode: 'local' },
    )).toEqual([
      {
        webId: 'https://id.example/alice/profile/card#me',
        storageUrl: 'https://node-0000.undefineds.co/alice/',
        storageMode: 'local',
      },
    ]);
  });

  it('uses provision lookup and rejects remote SP sibling leaks', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      entries: [
        {
          webId: 'https://id.example/alice/profile/card#me',
          storageUrl: 'https://node-0000.undefineds.co/alice/',
        },
        {
          webId: 'https://id.example/alice/profile/card#me',
          storageUrl: 'https://node-0001.undefineds.co/alice/',
        },
      ],
    })));

    await expect(lookupProvisionScopedWebIds(
      fetchMock as unknown as typeof fetch,
      [ 'https://id.example/alice/profile/card#me' ],
      {
        root: 'https://node-0000.undefineds.co/',
        lookupUrl: 'http://127.0.0.1:5737/',
        serviceToken: 'service-token',
        mode: 'local',
      },
    )).resolves.toEqual([
      {
        webId: 'https://id.example/alice/profile/card#me',
        storageUrl: 'https://node-0000.undefineds.co/alice/',
        storageMode: 'local',
      },
    ]);
  });

  it('parses Cloud-managed provision scope into a Local SP root', () => {
    const payload = Buffer.from(JSON.stringify({
      spDomain: 'node-0000.undefineds.co',
      spUrl: 'http://127.0.0.1:5737',
      serviceToken: 'service-token',
    })).toString('base64url');

    expect(currentStorageScope('https://id.example', `${payload}.signature`)).toEqual({
      root: 'https://node-0000.undefineds.co/',
      lookupUrl: 'http://127.0.0.1:5737/',
      serviceToken: 'service-token',
      mode: 'local',
    });
  });
});
