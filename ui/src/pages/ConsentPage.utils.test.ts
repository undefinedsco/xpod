import { describe, expect, test } from 'vitest';
import { consentResponseError, resolveConsentStorageBindings } from './ConsentPage.utils';
import { xpodConsentErrors } from '../auth/xpod-account-copy';

describe('Local pairing failure recovery', () => {
  const body = { errorCode: 'H400', message: 'Invalid or expired provisionCode.' };

  test('recognizes the rejected Local operation without exposing raw server text', () => {
    expect(consentResponseError(body, 'fallback', 400).message).toBe(xpodConsentErrors.invalidProvisionScope);
  });

  test.each([
    [body, 503],
    [body, 401],
    [{ message: body.message }, 400],
    [{ ...body, message: `${body.message} untrusted detail` }, 400],
  ])('keeps unrelated failures retryable (%j, HTTP %s)', (responseBody, status) => {
    expect(consentResponseError(responseBody, 'fallback', status as number).message).toBe('fallback');
  });
});

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
