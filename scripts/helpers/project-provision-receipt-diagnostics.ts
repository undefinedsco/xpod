import { ProvisionCodeCodec } from '../../src/provision/ProvisionCodeCodec';
import type { ProvisionReceiptPayload } from '../../src/provision/ProvisionReceiptCodec';
import { ensureTrailingSlash } from '../../src/runtime/base-url';

export interface ProvisionReceiptDiagnosticInput {
  cloudBaseUrl: unknown; canonicalBaseUrl: unknown; username: unknown;
  provisionCode: unknown; provisionReceipt: unknown; preparedPodUrl: unknown; preparedWebId: unknown;
}
export interface ProvisionReceiptDiagnostics {
  schemaVersion: 1; phase: 'cloud_pod_create'; signatureVerification: 'unobserved';
  provisionCodeParsed: boolean; nodeIdPresent: boolean; receiptParsed: boolean; receiptExpired: boolean | null;
  codeDomainMatchesCanonicalAuthority: boolean | null;
  preparedPodMatchesCanonical: boolean | null; receiptNameMatchesRequested: boolean | null;
  receiptPodMatchesPrepared: boolean | null; receiptPodMatchesCanonical: boolean | null;
  receiptWebIdMatchesPrepared: boolean | null;
}
export function projectProvisionReceiptDiagnostics(
  input: ProvisionReceiptDiagnosticInput, nowMs = Date.now(),
): ProvisionReceiptDiagnostics {
  const cloudBaseUrl = boundedString(input.cloudBaseUrl);
  const provisionCode = boundedString(input.provisionCode, 32768);
  const code = cloudBaseUrl && provisionCode ? new ProvisionCodeCodec(cloudBaseUrl).decode(provisionCode) : undefined;
  const receipt = readUnsignedReceipt(input.provisionReceipt);
  const canonicalBase = boundedString(input.canonicalBaseUrl);
  const username = boundedString(input.username, 256);
  let canonicalPod: string | undefined;
  let canonicalAuthority: string | undefined;
  if (canonicalBase) {
    try { canonicalAuthority = new URL(canonicalBase).host; } catch { /* Incomparable input. */ }
  }
  if (canonicalBase && username) {
    try { canonicalPod = new URL(`${encodeURIComponent(username)}/`, ensureTrailingSlash(canonicalBase)).href; } catch { /* Incomparable input. */ }
  }
  const preparedPod = normalizedPodRoot(input.preparedPodUrl);
  const expectedPod = normalizedPodRoot(canonicalPod);
  const receiptPod = normalizedPodRoot(receipt?.podUrl);
  const receiptWebId = comparableWebId(receipt?.webId);
  const preparedWebId = comparableWebId(input.preparedWebId);
  return { schemaVersion: 1, phase: 'cloud_pod_create', signatureVerification: 'unobserved',
    provisionCodeParsed: Boolean(code), nodeIdPresent: Boolean(code && boundedString(code.nodeId)),
    codeDomainMatchesCanonicalAuthority: equalIfComparable(code && boundedString(code.spDomain), canonicalAuthority),
    receiptParsed: Boolean(receipt), receiptExpired: receipt && Number.isFinite(nowMs) ? receipt.exp <= Math.floor(nowMs / 1000) : null,
    preparedPodMatchesCanonical: equalIfComparable(preparedPod, expectedPod),
    receiptNameMatchesRequested: receipt && username ? receipt.podName === username : null,
    receiptPodMatchesPrepared: equalIfComparable(receiptPod, preparedPod),
    receiptPodMatchesCanonical: equalIfComparable(receiptPod, expectedPod),
    receiptWebIdMatchesPrepared: equalIfComparable(receiptWebId, preparedWebId) };
}

function boundedString(value: unknown, max = 4096): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

/** Shape inspection only: this intentionally never calls the HMAC verifier. */
function readUnsignedReceipt(value: unknown): ProvisionReceiptPayload | undefined {
  const receipt = boundedString(value, 32768);
  if (!receipt) return undefined;
  const parts = receipt.split('.');
  if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/u.test(part))) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
    const row = payload as Record<string, unknown>;
    if (row.typ !== 'xpod-provision-receipt' || !boundedString(row.podName, 256)
      || !boundedString(row.podUrl) || !boundedString(row.webId)
      || typeof row.exp !== 'number' || !Number.isFinite(row.exp)) return undefined;
    return { typ: 'xpod-provision-receipt', podName: row.podName as string,
      podUrl: row.podUrl as string, webId: row.webId as string, exp: row.exp };
  } catch { return undefined; }
}

/** Same URL-root comparison as ProvisionPodCreator; diagnostic only, never a persisted reference. */
function normalizedPodRoot(value: unknown): string | undefined {
  const text = boundedString(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch { return undefined; }
}

function comparableWebId(value: unknown): string | undefined {
  const text = boundedString(value);
  if (!text || text !== text.trim() || /[\r\n\t]/u.test(text)) return undefined;
  try { new URL(text); return text; } catch { return undefined; }
}

function equalIfComparable(left: string | undefined, right: string | undefined): boolean | null {
  return left && right ? left === right : null;
}

export async function withProvisionReceiptFailureDiagnostics<T>(
  action: () => Promise<T>, input: () => ProvisionReceiptDiagnosticInput,
  sink: (projection: ProvisionReceiptDiagnostics) => void,
): Promise<T> {
  try { return await action(); } catch (error) {
    try { sink(projectProvisionReceiptDiagnostics(input())); } catch { /* Diagnostics cannot replace the original failure. */ }
    throw error;
  }
}
