import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AesInvocationTokenCodec } from '../../../src/api/ai-gateway/auth/InvocationTokenCodec';

const secret = 'fixture-signed-pod-scope';
const input = {
  deployment: 'local' as const, audience: 'https://gateway.example', issuer: 'https://gateway.example',
  webId: 'https://identity.example/alice/profile/card#me', scopes: ['models:read', 'inference:write'],
  issuedAt: new Date('2026-10-05T00:00:00Z'), expiresAt: new Date('2026-10-05T00:10:00Z'),
};
function authenticatedPayload(patch: Record<string, unknown>): string {
  const payload = { v: 1, kid: 'test', deployment: input.deployment, aud: input.audience, iss: input.issuer,
    webId: input.webId, scopes: input.scopes, iat: input.issuedAt.getTime(), exp: input.expiresAt.getTime(),
    jti: 'fixture_identifier_123', ...patch };
  const nonce = randomBytes(12);
  const key = createHash('sha256').update('xpod:gateway:internal-invocation:v1\0').update(secret).digest();
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('xpod:gateway:internal-invocation:v1.test'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return ['xpod_inv_v1', 'test', nonce.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

describe('signed invocation Pod scope', () => {
  const codec = new AesInvocationTokenCodec({ active: { kid: 'test', secret } });
  it('round-trips a canonical storage binding while retaining complete owner identity', () => {
    const claims = codec.decode(codec.encode({ ...input, podUrl: 'https://storage.example/local/alice/' }));
    expect(claims).toMatchObject({ webId: input.webId, podUrl: 'https://storage.example/local/alice/', scopes: input.scopes });
    expect(codec.decode(codec.encode(input))?.podUrl).toBeUndefined();
    expect(codec.decode(authenticatedPayload({ podUrl: 'https://storage.example/local/alice/' }))?.podUrl)
      .toBe('https://storage.example/local/alice/');
  });
  it.each([
    '', 'https://storage.example/alice/#me', 'https://storage.example/alice/?scope=all',
    'https://user:password@storage.example/alice/', 'ftp://storage.example/alice/',
    'https://storage.example/other/../alice/',
  ])('rejects malformed Pod scope at issuance and after authentic decryption: %s', podUrl => {
    expect(() => codec.encode({ ...input, podUrl })).toThrow();
    expect(codec.decode(authenticatedPayload({ podUrl }))).toBeUndefined();
  });
  it.each([null, 42, ['https://storage.example/alice/']])('rejects non-string authenticated scope %j', podUrl => {
    expect(codec.decode(authenticatedPayload({ podUrl }))).toBeUndefined();
  });
  it('rejects undeclared claims even with an authentic envelope', () => {
    expect(codec.decode(authenticatedPayload({ podUrl: 'https://storage.example/alice/', allPods: true }))).toBeUndefined();
  });
});
