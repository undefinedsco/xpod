import { createHash } from 'node:crypto';
import path from 'node:path';
import { explicitLicenseConflicts, LEGAL_GRANT_TEMPLATE_PATHS, verifyApacheGrantText,
  verifyIscGrantText, verifyMitGrantText } from './legal-admission';

/** Text-only observation of *already supplied* native original license
 * material. It never selects an origin, applies a license to a member, or
 * issues a grant/capability. A caller that needs applicability authority must
 * bind these findings to a separately verified origin and license scope. */
export interface NativeOriginalLicenseNoticesInput {
  readonly declaredLicense: string;
  readonly grant: Buffer;
  readonly notices: readonly Readonly<{ path: string; bytes: Buffer }>[];
  readonly retained: readonly Readonly<{ bytes: number; sha256: string }>[];
  readonly sourceTexts: readonly Buffer[];
  readonly templates: Readonly<{ mit: Buffer; isc: Buffer; apache: Buffer }>;
  /** Shared parent cancellation/clock check; thrown errors propagate unchanged. */
  readonly check: () => void;
}

const SUPPORTED = new Set(['MIT', 'ISC', 'Apache-2.0']);
const SHA256 = /^[a-f0-9]{64}$/u;
const fail = (message: string): never => { throw new Error('Native original license notices: ' + message); };
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const relativeNoticePath = (name: unknown): name is string => typeof name === 'string' && name.length > 0
  && !name.includes('\\') && !name.startsWith('/') && !/[\u0000-\u001f\u007f]/u.test(name)
  && path.posix.normalize(name) === name && !name.split('/').some(part => !part || part === '.' || part === '..');

/** Pure text conclusion. Supported grant texts reuse the reviewed MIT/ISC/
 * Apache parsers and must be byte-custodied by the actual retained originals.
 * Every other declared license stays pending; nothing is inferred from general
 * prose or from a public-domain label. */
export function inspectNativeOriginalLicenseNotices(input: NativeOriginalLicenseNoticesInput): string[] {
  if (!input || typeof input !== 'object') fail('complete input object required');
  const { check } = input;
  if (typeof check !== 'function') fail('shared parent check required');
  if (!Buffer.isBuffer(input.grant)) fail('actual grant bytes required');
  if (!Array.isArray(input.notices) || !Array.isArray(input.retained) || !Array.isArray(input.sourceTexts)) fail('notice/retained/source collections required');
  const pending: string[] = [];
  const retained = new Map<string, number>();
  for (const row of input.retained) {
    if (!row || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || typeof row.sha256 !== 'string' || !SHA256.test(row.sha256)) fail('malformed retained original record');
    const known = retained.get(row.sha256);
    if (known !== undefined && known !== row.bytes) fail('conflicting retained original records');
    retained.set(row.sha256, row.bytes);
  }
  // Every hash/parse observation is bracketed by the shared parent check; the
  // check's own exception is the cancellation signal and is never swallowed.
  const custody = (label: string, bytes: Buffer): void => {
    check();
    const digest = sha256(bytes);
    check();
    if (retained.get(digest) !== bytes.length) pending.push(label + ' actual SHA-256/byte length absent from retained originals: ' + digest);
  };
  check();
  custody('Normative grant', input.grant);
  const declared = input.declaredLicense;
  if (typeof declared !== 'string' || !declared.trim()) pending.push('Declared license missing; no permission inferred from grant prose');
  else if (!SUPPORTED.has(declared)) pending.push('Declared license requires another explicit grant adapter, not a public-domain guess: ' + declared);

  if (typeof declared === 'string' && SUPPORTED.has(declared)) {
    const templates = input.templates;
    if (!templates || !Buffer.isBuffer(templates.mit) || !Buffer.isBuffer(templates.isc) || !Buffer.isBuffer(templates.apache)) fail('reviewed mit/isc/apache template bytes required');
    check();
    const parsed = declared === 'MIT' ? verifyMitGrantText(input.grant, templates.mit)
      : declared === 'ISC' ? verifyIscGrantText(input.grant, templates.isc, declared)
        : verifyApacheGrantText(input.grant, templates.apache, declared);
    check();
    if (!parsed) pending.push('Grant text does not satisfy the reviewed ' + declared + ' original parser; template ' + LEGAL_GRANT_TEMPLATE_PATHS[declared === 'MIT' ? 'mit' : declared === 'ISC' ? 'isc' : 'apache']);
    for (const message of explicitLicenseConflicts(input.grant, declared as 'MIT' | 'ISC' | 'Apache-2.0')) pending.push('Grant text contains an explicit conflicting license: ' + message);
    input.sourceTexts.forEach((bytes, index) => {
      if (!Buffer.isBuffer(bytes)) fail('source text bytes required at index ' + index);
      check();
      const conflicts = explicitLicenseConflicts(bytes, declared as 'MIT' | 'ISC' | 'Apache-2.0');
      check();
      for (const message of conflicts) pending.push('Source text ' + index + ' contains an explicit conflicting license: ' + message);
    });
  } else {
    input.sourceTexts.forEach((bytes, index) => { if (!Buffer.isBuffer(bytes)) fail('source text bytes required at index ' + index); });
  }

  if (input.notices.length === 0) pending.push('Original license notice missing: no original notice file was supplied');
  const seen = new Set<string>();
  input.notices.forEach((notice, index) => {
    if (!notice || typeof notice !== 'object' || !relativeNoticePath(notice.path)) fail('canonical relative notice path required at index ' + index);
    if (!Buffer.isBuffer(notice.bytes)) fail('actual notice bytes required at index ' + index);
    if (seen.has(notice.path)) fail('duplicate original notice path: ' + notice.path);
    seen.add(notice.path);
    custody('Original notice ' + notice.path, notice.bytes);
  });
  check();
  return [...new Set(pending)];
}
