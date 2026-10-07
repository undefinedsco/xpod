import { describe, expect, it, vi } from 'vitest';
import { ProvisionCodeCodec } from '../../src/provision/ProvisionCodeCodec';
import { createProvisionReceipt } from '../../src/provision/ProvisionReceiptCodec';
import {
  projectProvisionReceiptDiagnostics, withProvisionReceiptFailureDiagnostics,
} from '../../scripts/helpers/project-provision-receipt-diagnostics';

const NOW = 1800000000000;
const CANARY = 'PRIVATE_RECEIPT_TOKEN_BODY_ERROR_CANARY';
function input(spDomain = 'storage.example') {
  const username = 'accept-alice';
  const podUrl = 'https://storage.example/accept-alice/';
  const webId = podUrl + 'public-id#me';
  return { cloudBaseUrl: 'https://identity.example/', canonicalBaseUrl: 'https://storage.example/',
    username, preparedPodUrl: podUrl, preparedWebId: webId,
    provisionCode: new ProvisionCodeCodec('https://identity.example/').encode({ spUrl: 'https://storage.example/',
      spDomain,
      nodeId: CANARY, serviceAccessToken: CANARY, serviceAccessTokenExp: Date.now() / 1000 + 300,
      exp: Date.now() / 1000 + 300 }),
    provisionReceipt: createProvisionReceipt({ secret: CANARY, podName: username, podUrl, webId, now: () => NOW }),
  };
}

describe('provision receipt failure diagnostics', () => {
  it('projects actual receipt/code fixtures as fixed booleans without signature claims or values', () => {
    const value = projectProvisionReceiptDiagnostics(input(), NOW);
    expect(value).toEqual({ schemaVersion: 1, phase: 'cloud_pod_create', signatureVerification: 'unobserved',
      provisionCodeParsed: true, nodeIdPresent: true, codeDomainMatchesCanonicalAuthority: true,
      receiptParsed: true, receiptExpired: false,
      preparedPodMatchesCanonical: true, receiptNameMatchesRequested: true,
      receiptPodMatchesPrepared: true, receiptPodMatchesCanonical: true, receiptWebIdMatchesPrepared: true });
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE|https:|accept-alice|public-id/);
  });

  it('reports expiry at the exact receipt boundary without claiming signature validity', () => {
    const data = input();
    data.provisionReceipt = createProvisionReceipt({ secret: CANARY, podName: data.username,
      podUrl: data.preparedPodUrl, webId: data.preparedWebId, expiresAt: NOW / 1000 });
    expect(projectProvisionReceiptDiagnostics(data, NOW).receiptExpired).toBe(true);
    expect(projectProvisionReceiptDiagnostics(data, NOW).signatureVerification).toBe('unobserved');
  });

  it('reports independently mismatched receipt fields and prepared canonical location', () => {
    const data = input();
    data.preparedPodUrl = 'https://other.example/other/';
    data.provisionReceipt = createProvisionReceipt({ secret: CANARY, podName: 'different',
      podUrl: 'https://third.example/other/', webId: 'https://third.example/id#other', now: () => NOW });
    const value = projectProvisionReceiptDiagnostics(data, NOW);
    expect(value.preparedPodMatchesCanonical).toBe(false);
    expect(value.receiptNameMatchesRequested).toBe(false);
    expect(value.receiptPodMatchesPrepared).toBe(false);
    expect(value.receiptPodMatchesCanonical).toBe(false);
    expect(value.receiptWebIdMatchesPrepared).toBe(false);
  });

  it('uses Pod-root comparison for trailing slash but keeps WebID equality exact', () => {
    const data = input();
    data.preparedPodUrl = data.preparedPodUrl.slice(0, -1);
    data.preparedWebId += ' ';
    const value = projectProvisionReceiptDiagnostics(data, NOW);
    expect(value.preparedPodMatchesCanonical).toBe(true);
    expect(value.receiptPodMatchesPrepared).toBe(true);
    expect(value.receiptWebIdMatchesPrepared).toBeNull();
  });

  it.each([undefined, 123, '', CANARY, 'a.b.c', 'a'.repeat(32769), 'W10.signature', 'e30.signature']
    .map((provisionReceipt, caseId) => ({ provisionReceipt, caseId })))(
    'does not trust malformed or oversized receipt case $caseId', ({ provisionReceipt }) => {
      const value = projectProvisionReceiptDiagnostics({ ...input(), provisionReceipt }, NOW);
      expect(value.receiptParsed).toBe(false);
      expect(value.receiptExpired).toBeNull();
      expect(value.receiptNameMatchesRequested).toBeNull();
      expect(value.receiptPodMatchesPrepared).toBeNull();
      expect(value.receiptWebIdMatchesPrepared).toBeNull();
      expect(JSON.stringify(value)).not.toContain(CANARY);
    });

  it('compares actual signed code domain to canonical authority without exposing it', () => {
    const value = projectProvisionReceiptDiagnostics(input('other.example'), NOW);
    expect(value.codeDomainMatchesCanonicalAuthority).toBe(false);
    expect(JSON.stringify(value)).not.toContain('other.example');
    expect(projectProvisionReceiptDiagnostics(input(CANARY), NOW).codeDomainMatchesCanonicalAuthority).toBe(false);
  });

  it('keeps code-domain comparison unknown when domain is absent or canonical URL is invalid', () => {
    const data = input();
    data.provisionCode = new ProvisionCodeCodec(data.cloudBaseUrl).encode({ spUrl: 'https://storage.example/',
      nodeId: CANARY, serviceToken: CANARY, exp: Date.now() / 1000 + 300 });
    expect(projectProvisionReceiptDiagnostics(data, NOW).codeDomainMatchesCanonicalAuthority).toBeNull();
    expect(projectProvisionReceiptDiagnostics({ ...input(), canonicalBaseUrl: 'not a URL' }, NOW)
      .codeDomainMatchesCanonicalAuthority).toBeNull();
  });

  it('ignores untrusted extra fields and signature contents in a parseable unsigned payload', () => {
    const data = input();
    const payload = { typ: 'xpod-provision-receipt', podName: data.username, podUrl: data.preparedPodUrl,
      webId: data.preparedWebId, exp: NOW / 1000 + 30, secret: CANARY, signatureVerification: 'valid',
      body: CANARY, extra: { message: CANARY } };
    data.provisionReceipt = Buffer.from(JSON.stringify(payload)).toString('base64url') + '.not-a-valid-hmac';
    const value = projectProvisionReceiptDiagnostics(data, NOW);
    expect(value.receiptParsed).toBe(true);
    expect(value.signatureVerification).toBe('unobserved');
    expect(JSON.stringify(value)).not.toContain(CANARY);
  });

  it('does not infer node identity when public provision-code decoding fails', () => {
    const value = projectProvisionReceiptDiagnostics({ ...input(), provisionCode: CANARY }, NOW);
    expect(value.provisionCodeParsed).toBe(false);
    expect(value.nodeIdPresent).toBe(false);
  });

  it('returns null for missing prepared WebID and invalid canonical URL without mutating input', () => {
    const data = { ...input(), preparedWebId: undefined, canonicalBaseUrl: 'not a URL' };
    const snapshot = { ...data };
    const value = projectProvisionReceiptDiagnostics(data, NOW);
    expect(value.receiptWebIdMatchesPrepared).toBeNull();
    expect(value.preparedPodMatchesCanonical).toBeNull();
    expect(value.receiptPodMatchesCanonical).toBeNull();
    expect(data).toEqual(snapshot);
  });

  it('isolates an actual projection property failure from the original exception', async () => {
    const original = new Error('controlled original failure');
    const data = input();
    Object.defineProperty(data, 'provisionReceipt', { get: () => { throw new Error(CANARY); } });
    const sink = vi.fn();
    await expect(withProvisionReceiptFailureDiagnostics(async () => { throw original; }, () => data, sink)).rejects.toBe(original);
    expect(sink).not.toHaveBeenCalled();
  });

  it('preserves original rejection and calls a controlled diagnostic sink only on failure', async () => {
    const error = new Error(CANARY);
    const action = vi.fn(async () => { throw error; });
    const sink = vi.fn();
    await expect(withProvisionReceiptFailureDiagnostics(action, () => input(), sink)).rejects.toBe(error);
    expect(action).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledOnce();
    expect(JSON.stringify(sink.mock.calls)).not.toContain(CANARY);
  });

  it('preserves successful return identity without touching diagnostic input or sink', async () => {
    const result = { publicResult: true };
    const action = vi.fn(async () => result);
    const diagnosticInput = vi.fn(() => input());
    const sink = vi.fn();
    await expect(withProvisionReceiptFailureDiagnostics(action, diagnosticInput, sink)).resolves.toBe(result);
    expect(action).toHaveBeenCalledOnce();
    expect(diagnosticInput).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
  });

  it.each(['input', 'sink'])('isolates a throwing diagnostic %s from the original rejection', async failure => {
    const original = { controlledFailure: true };
    const action = async () => { throw original; };
    const diagnosticInput = () => { if (failure === 'input') throw new Error(CANARY); return input(); };
    const sink = () => { throw new Error(CANARY); };
    await expect(withProvisionReceiptFailureDiagnostics(action, diagnosticInput, sink)).rejects.toBe(original);
  });
});
