import { describe, expect, test } from 'vitest';
import { resolveConsentStorageBindings } from './ConsentPage.utils';

describe('ConsentPage storage binding normalization', () => {
  test('preserves exact-pair metadata so duplicate conflicts reach selection reconciliation', () => {
    expect(resolveConsentStorageBindings([
      {
        webId: 'https://app.example/alice/profile/card#me',
        storageUrl: 'https://app.example/alice/',
        label: 'Alice Pod',
      },
    ])).toEqual([{
      webId: 'https://app.example/alice/profile/card#me',
      storageUrl: 'https://app.example/alice/',
      label: 'Alice Pod',
    }]);
    expect(resolveConsentStorageBindings([
      {
        webId: 'https://app.example/alice/profile/card#me',
        storageUrl: 'https://app.example/alice/',
        label: 'Alice Pod',
      },
      {
        webId: 'https://app.example/alice/profile/card#me',
        storageUrl: 'https://app.example/alice/',
        label: 'Renamed Pod',
      },
    ])).toHaveLength(2);
  });
});

test.each(['https://APP.EXAMPLE/alice/profile/card#me', 'https://app.example:443/alice/profile/card#me', 'https://app.example/alice/other/../profile/card#me', 'https://app.example/alice/profile/card?view=1#me', 'https://app.example/alice/profile/card#other'])('preserves consent WebID original text without deduplication: %s', (webId) => {
  const bindings = ['https://app.example/alice/profile/card#me', webId].map((identity) => ({ webId: identity, storageUrl: 'https://app.example/alice/' }));
  expect(resolveConsentStorageBindings(bindings)).toEqual(bindings);
});

test.each([' https://app.example/alice/profile/card#me', 'https://app.example/alice/profile/card#me ', 'https://app.example/alice/pro\rfile/card#me', 'https://app.example/alice/pro\nfile/card#me', 'https://app.example/alice/pro\tfile/card#me'])('rejects whitespace in consent WebID: %j', (webId) => {
  expect(resolveConsentStorageBindings([{ webId, storageUrl: 'https://app.example/alice/' }])).toEqual([]);
});
