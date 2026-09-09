import { describe, expect, it } from 'vitest';
import {
  createProvisionReceipt,
  deriveProvisionReceiptSecret,
  verifyProvisionReceipt,
} from '../../src/provision/ProvisionReceiptCodec';

const now = () => 1_700_000_000_000;
const input = {
  secret: deriveProvisionReceiptSecret('long-lived-service-token'),
  podName: 'alice',
  webId: 'https://id.example/alice/profile/card#me',
  podUrl: 'https://node.example/alice/',
  now,
};

describe('ProvisionReceiptCodec', () => {
  it('signs all immutable binding facts', () => {
    const receipt = createProvisionReceipt(input);
    const result = verifyProvisionReceipt(receipt, { secret: input.secret, now });

    expect(result).toEqual({
      valid: true,
      payload: {
        typ: 'xpod-provision-receipt',
        podName: input.podName,
        webId: input.webId,
        podUrl: input.podUrl,
        exp: 1_700_000_300,
      },
    });
  });

  it('rejects a different service token', () => {
    const receipt = createProvisionReceipt(input);
    expect(verifyProvisionReceipt(receipt, { secret: deriveProvisionReceiptSecret('different-token'), now })).toEqual({
      valid: false,
      reason: 'signature',
    });
  });

  it('does not accept the raw service token as the receipt signing secret', () => {
    const receipt = createProvisionReceipt(input);
    expect(verifyProvisionReceipt(receipt, { secret: 'long-lived-service-token', now })).toEqual({
      valid: false,
      reason: 'signature',
    });
  });

  it('rejects a modified payload', () => {
    const receipt = createProvisionReceipt(input);
    const [data, signature] = receipt.split('.');
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as Record<string, unknown>;
    payload.podName = 'mallory';
    const modified = `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.${signature}`;

    expect(verifyProvisionReceipt(modified, { secret: input.secret, now })).toEqual({
      valid: false,
      reason: 'signature',
    });
  });

  it('rejects an expired receipt', () => {
    const receipt = createProvisionReceipt({ ...input, expiresAt: 1_700_000_001 });
    expect(verifyProvisionReceipt(receipt, {
      secret: input.secret,
      now: () => 1_700_000_002_000,
    })).toEqual({ valid: false, reason: 'expired' });
  });
});
