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
