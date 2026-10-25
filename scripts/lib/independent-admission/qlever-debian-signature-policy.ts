import { createHash } from 'node:crypto';

/** Reviewed Bookworm trust roots. This is controller policy, never SDK data. */
export const DEBIAN_BOOKWORM_KEYS = Object.freeze([
  Object.freeze({file: 'archive-key-12.asc', sha256: 'c2a9a16fde95e037bafd0fa6b7e31f41b4ff1e85851de5558f19a2a2f0e955e2', primary: 'B8B80B5B623EAB6AD8775C45B7C5D7D6350947F8', signing: '4CB50190207B4758A3F73A796ED0E7B82643E131', until: '2031-01-19T11:44:21Z', role: 'archive'}),
  Object.freeze({file: 'archive-key-12-security.asc', sha256: '74f81645b4e3156d1e9a88c8dd9259271b89c7099d64af89a2a6996b592faa1f', primary: '05AB90340C0C5E797F44A8C8254CF3B5AEC0A8F0', signing: 'B0CAB9266E8C3929798B3EEEBDE6D2B9216EC7A8', until: '2031-01-19T11:45:33Z', role: 'security'}),
  Object.freeze({file: 'release-12.asc', sha256: '521e9f6a9f9b92ee8d5ce74345e8cfd04028dae9db6f571259d584b293549824', primary: '4D64FEC119C2029067D6E791F8D2585B8783D481', signing: '4D64FEC119C2029067D6E791F8D2585B8783D481', until: '2031-01-21T16:44:03Z', role: 'release'}),
] as const);
export type DebianReleaseFamily='bookworm'|'trixie';
export interface DebianReleaseKeyPolicy {readonly file:string;readonly sha256:string;readonly primary:string;readonly signing:string;readonly until:string;readonly role:'archive'|'security'|'release'}
/** Separately reviewed Debian 13 roots; Debian 12 signatures cannot authorize Trixie. */
export const DEBIAN_TRIXIE_KEYS=Object.freeze([
 Object.freeze({file:'archive-key-13.asc',sha256:'6f1d277429dd7ffedcc6f8688a7ad9a458859b1139ffa026d1eeaadcbffb0da7',primary:'04B54C3CDCA79751B16BC6B5225629DF75B188BD',signing:'B8E5F13176D2A7A75220028078DBA3BC47EF2265',until:'2035-03-28T12:50:29Z',role:'archive'}),
 Object.freeze({file:'archive-key-13-security.asc',sha256:'844c07d242db37f283afab9d5531270a0550841e90f9f1a9c3bd599722b808b7',primary:'5E04A1E3223A19A20706E20F9904613D4CCE68C6',signing:'89C87ACEA5DD6B8E6A7068808E9F831205B4BA95',until:'2035-03-28T12:51:41Z',role:'security'}),
 Object.freeze({file:'release-13.asc',sha256:'4d097bb93f83d731f475c5b92a0c2fcf108cfce1d4932792fca72d00b48d198b',primary:'41587F7DB8C774BCCF131416762F67A0B2C39DE4',signing:'41587F7DB8C774BCCF131416762F67A0B2C39DE4',until:'2033-03-22T18:56:21Z',role:'release'}),
] as const);
export function debianReleaseKeyPolicies(family:DebianReleaseFamily):readonly DebianReleaseKeyPolicy[]{need(family==='bookworm'||family==='trixie','exact reviewed Debian family');return family==='bookworm'?DEBIAN_BOOKWORM_KEYS:DEBIAN_TRIXIE_KEYS;}
export function debianSignatureFamilyForSdkProfile(profile:unknown):DebianReleaseFamily {need(profile==='module-bookworm-gcc12'||profile==='service-trixie','exact SDK Debian profile');return profile==='service-trixie'?'trixie':'bookworm';}
function need(value: unknown, reason: string): asserts value { if (!value) throw Error('Debian signature policy: ' + reason); }

/** Mechanical armor/primary packet identity only; gpgv verifies signatures. */
export function inspectDebianPublicKeyOriginal(bytes: Buffer, policy: DebianReleaseKeyPolicy): Buffer {
  need(bytes.length <= 32768 && createHash('sha256').update(bytes).digest('hex') === policy.sha256, 'official key original differs');
  const text = bytes.toString('ascii'), lines = text.trimEnd().split('\n');
  need(lines.shift() === '-----BEGIN PGP PUBLIC KEY BLOCK-----' && lines.pop() === '-----END PGP PUBLIC KEY BLOCK-----', 'public key armor differs');
  const encoded = lines.filter(line => line && !line.startsWith('=') && !line.includes(':')).join('');
  need(/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded), 'public key encoding differs');
  const raw = Buffer.from(encoded, 'base64'); need(raw.toString('base64') === encoded, 'public key base64 differs');
  const fingerprints: {tag: number; fingerprint: string}[] = [];
  for (let at = 0; at < raw.length;) {
    const header = raw[at++]!; need(header & 128, 'public key packet header'); let tag: number, size: number;
    if (header & 64) {
      tag = header & 63; const length = raw[at++]!;
      if (length < 192) size = length;
      else if (length < 224) size = (length - 192) * 256 + raw[at++]! + 192;
      else { need(length === 255 && at + 4 <= raw.length, 'bounded complete key packet required'); size = raw.readUInt32BE(at); at += 4; }
    } else { tag = (header >> 2) & 15; const count = 1 << (header & 3); need(count <= 4 && at + count <= raw.length, 'key packet size'); size = raw.readUIntBE(at, count); at += count; }
    need(Number.isSafeInteger(size) && size > 0 && at + size <= raw.length, 'key packet bounds');
    const body = raw.subarray(at, at + size); at += size;
    if (tag === 6 || tag === 14) {
      need(body[0] === 4 && size <= 65535, 'reviewed v4 key required');
      const prefix = Buffer.alloc(3); prefix[0] = 0x99; prefix.writeUInt16BE(size, 1);
      fingerprints.push({tag, fingerprint: createHash('sha1').update(prefix).update(body).digest('hex').toUpperCase()});
    }
  }
  need(fingerprints.filter(row => row.tag === 6).length === 1 && fingerprints.find(row => row.tag === 6)?.fingerprint === policy.primary
    && fingerprints.some(row => row.fingerprint === policy.signing), 'reviewed primary/signing fingerprint differs');
  return raw;
}

export function inspectDebianReleaseSuite(body: Buffer, acquisitionUTC: number, indexPaths: readonly string[], family:DebianReleaseFamily='bookworm') {
  need(body.length > 0 && body.length <= 4 * 1024 ** 2 && !body.includes(0) && !body.includes(13) && Number.isFinite(acquisitionUTC), 'bounded signed Release and actual acquisition time required');
  const fields = new Map<string, string>(); let current = '';
  for (const line of body.toString('utf8').trimEnd().split('\n')) {
    if (/^[ \t]/u.test(line)) { need(current, 'orphan Release continuation'); fields.set(current, fields.get(current)! + '\n' + line.trim()); continue; }
    const colon = line.indexOf(':'); const key = line.slice(0, colon).toLowerCase();
    need(colon > 0 && /^[a-z][a-z0-9-]*$/u.test(key) && !fields.has(key), 'duplicate/malformed signed Release field'); current = key; fields.set(key, line.slice(colon + 1).trim());
  }
  debianReleaseKeyPolicies(family);const codename = fields.get('codename'), security = codename === family+'-security', backports = family==='bookworm'&&codename === 'bookworm-backports';
  const suites: Record<string, readonly string[]> = family==='trixie'?{trixie:['stable'],'trixie-updates':['stable-updates'],'trixie-security':['stable-security']}:{bookworm: ['stable', 'oldstable'], 'bookworm-updates': ['stable-updates', 'oldstable-updates'], 'bookworm-security': ['stable-security', 'oldstable-security'], 'bookworm-backports': ['oldstable-backports']};
  need(codename && suites[codename]?.includes(fields.get('suite')!) && fields.get('origin') === (backports ? 'Debian Backports' : 'Debian')
    && fields.get('label') === (security ? 'Debian-Security' : backports ? 'Debian Backports' : 'Debian'), 'reviewed '+family+' suite identity required');
  const date = Date.parse(fields.get('date') ?? ''), until = fields.has('valid-until') ? Date.parse(fields.get('valid-until')!) : undefined;
  need(Number.isFinite(date) && date <= acquisitionUTC + 10000 && (until === undefined || Number.isFinite(until) && date <= until && acquisitionUTC <= until), 'Release not valid at actual acquisition time');
  // Match default APT semantics: absent Valid-Until grants no invented expiry.
  // The absence is retained as an explicit fact, rather than silently supplied.
  need(!(security || backports) || until !== undefined, 'security/backports Release requires Valid-Until');
  const components = (fields.get('components') ?? '').split(/\s+/u).map(value => security ? value.replace(/^updates\//u, '') : value);
  need(indexPaths.length > 0 && indexPaths.every(value => /^(?:main|contrib|non-free|non-free-firmware)\/source\/Sources(?:\.(?:gz|xz|bz2))?$/u.test(value) && components.includes(value.split('/')[0]!)), 'signed Sources component differs');
  return Object.freeze({codename, role: security ? 'security' as const : backports ? 'backports' as const : codename === family+'-updates' ? 'updates' as const : 'archive' as const, dateUTC: date, validUntilUTC: until ?? null, validUntilPresent: until !== undefined});
}

/** Parse strict clear-signed Release framing. Signature mathematics remain gpgv's. */
export function extractDebianSignedRelease(original: Buffer): Buffer {
  need(original.length <= 4 * 1024 ** 2 && !original.includes(0) && !original.includes(13), 'canonical clear-signed Release bytes required');
  const text = original.toString('utf8'); need(Buffer.from(text).equals(original), 'UTF-8 Release required');
  const split = text.indexOf('\n\n'), marker = '\n-----BEGIN PGP SIGNATURE-----\n';
  const header = text.slice(0, split).split('\n');
  need(split > 0 && header.shift() === '-----BEGIN PGP SIGNED MESSAGE-----' && header.length > 0 && header.every(line => line.startsWith('Hash: ')), 'clear-signature header differs');
  const tail = text.slice(split + 2), at = tail.indexOf(marker);
  need(at > 0 && at === tail.lastIndexOf(marker) && text.indexOf('-----BEGIN PGP SIGNED MESSAGE-----') === text.lastIndexOf('-----BEGIN PGP SIGNED MESSAGE-----') && tail.trimEnd().endsWith('-----END PGP SIGNATURE-----'), 'single complete signed Release required');
  const signature = tail.slice(at + marker.length).trimEnd().split('\n');
  need(signature.pop() === '-----END PGP SIGNATURE-----', 'signature end required');
  while (signature[0]?.startsWith('Version: ') || signature[0]?.startsWith('Comment: ')) signature.shift();
  need(signature.shift() === '', 'signature armor separator required');
  if (signature[signature.length - 1]?.startsWith('=')) need(/^=[A-Za-z0-9+/]{4}$/u.test(signature.pop()!), 'signature armor CRC shape');
  const encoded = signature.join('');
  need(signature.length > 0 && signature.every(line => /^[A-Za-z0-9+/]+={0,2}$/u.test(line)) && Buffer.from(encoded, 'base64').toString('base64') === encoded, 'single signature packet armor required');
  const body = tail.slice(0, at).split('\n').map(line => line.startsWith('- ') ? line.slice(2) : line).join('\n') + '\n';
  return Buffer.from(body);
}

/** The extra NO_PUBKEY co-signature is NOT trusted. This closed exception is
 * based on actual official Bookworm+Trixie co-signature gpgv status originals.
 * A complete permitted VALIDSIG is still mandatory for the identical input. */
const isPlaintext = (args: string[]) => args.length === 3 && args[0] === '74' && args[1] === '0' && args[2] === '';
export function inspectDebianGpgvStatus(status: Buffer, role: 'archive' | 'updates' | 'security' | 'backports', acquisitionUTC: number, exit = 0, expectPlaintext = false, family:DebianReleaseFamily='bookworm') {
  need(status.length > 0 && status.length <= 65536 && !status.includes(0) && [0, 2].includes(exit), 'bounded completed gpgv status required');
  const keys=debianReleaseKeyPolicies(family);const groups: {name: string; args: string[]}[][] = []; let plaintext = false;
  for (const line of status.toString('utf8').trimEnd().split('\n')) {
    need(line.startsWith('[GNUPG:] '), 'non-status output'); const [name, ...args] = line.slice(9).split(' ');
    if (name === 'PLAINTEXT') {need(!plaintext && groups.length === 0 && isPlaintext(args), 'single text signature output prelude required'); plaintext = true; continue;}
    if (name === 'NEWSIG') {need(args.length === 0, 'unexpected signature identity'); groups.push([]); continue;}
    need(groups.length > 0 && ['KEY_CONSIDERED', 'SIG_ID', 'GOODSIG', 'VALIDSIG', 'ERRSIG', 'NO_PUBKEY'].includes(name!), 'unaccepted signature status:' + name);
    groups[groups.length - 1]!.push({name: name!, args});
  }
  need((!expectPlaintext || plaintext) && groups.length > 0 && groups.length <= 16 && Number.isFinite(acquisitionUTC), 'bounded actual signature groups required');
  const accepted: string[] = [], unknown: string[] = [];
  for (const group of groups) {
    if (group.some(row => row.name === 'ERRSIG' || row.name === 'NO_PUBKEY')) {
      need(group.length === 2 && group[0]!.name === 'ERRSIG' && group[1]!.name === 'NO_PUBKEY', 'unknown co-signature status set differs');
      const error = group[0]!.args, missing = group[1]!.args;
      need(error.length === 7 && /^[A-F0-9]{16}$/u.test(error[0]!) && /^[A-F0-9]{40}$/u.test(error[6]!) && error[6]!.endsWith(error[0]!)
        && error[5] === '9' && error[3] === '01' && ['8', '9', '10'].includes(error[2]!) && /^[0-9]+$/u.test(error[1]!) && /^[0-9]+$/u.test(error[4]!)
        && missing.length === 1 && missing[0] === error[0] && !keys.some(key => key.signing === error[6] || key.primary === error[6]), 'unmatched unknown co-signature required');
      if(family==='trixie')need(DEBIAN_BOOKWORM_KEYS.some(key=>key.signing===error[6]&&(role==='security'?key.role==='security':key.role==='archive')),'only exact non-authority Debian 12 co-signature permitted');
      unknown.push(error[6]!); continue;
    }
    const valid = group.filter(row => row.name === 'VALIDSIG'), good = group.filter(row => row.name === 'GOODSIG'), ids = group.filter(row => row.name === 'SIG_ID');
    need(valid.length === 1 && good.length === 1 && ids.length === 1, 'complete single valid signature group required');
    const args = valid[0]!.args;
    const policy = keys.find(key => key.primary === args[9] && key.signing === args[0]
      && (role === 'security' ? key.role === 'security' : role === 'updates' || role === 'backports' ? key.role === 'archive' : key.role !== 'security'));
    need(policy && args.length === 10 && ['8', '9', '10'].includes(args[7]!) && args[8] === '01' && args[6] === (policy.role === 'release' ? '22' : '1') && args[4] === '4' && args[5] === '0'
      && /^[0-9]+$/u.test(args[2]!) && /^[0-9]+$/u.test(args[3]!) && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(args[1]!)
      && good[0]!.args[0] === policy.signing.slice(-16) && ids[0]!.args.length === 3 && ids[0]!.args[1] === args[1] && ids[0]!.args[2] === args[2]
      && group.filter(row => row.name === 'KEY_CONSIDERED').every(row => row.args.length === 2 && row.args[0] === policy.primary && row.args[1] === '0'), 'reviewed complete strong Release signature required');
    const created = Number(args[2]) * 1000, expires = Number(args[3]) * 1000;
    need(Number.isFinite(created) && created > 0 && created <= acquisitionUTC + 10000 && acquisitionUTC < Date.parse(policy.until)
      && Number.isFinite(expires) && (expires === 0 || acquisitionUTC <= expires), 'signature outside reviewed acquisition validity'); accepted.push(policy.primary);
  }
  need(accepted.length > 0 && (exit === 0 ? unknown.length === 0 : unknown.length > 0), 'exit/status co-signature closure differs');
  return Object.freeze({signers: Object.freeze([...new Set(accepted)]), nonAuthorityCoSignatures: Object.freeze(unknown)});
}
