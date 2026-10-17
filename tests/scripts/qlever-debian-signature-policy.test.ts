import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {expect, it} from 'vitest';
import {DEBIAN_BOOKWORM_KEYS, inspectDebianPublicKeyOriginal, extractDebianSignedRelease, inspectDebianReleaseSuite, inspectDebianGpgvStatus} from '../../scripts/lib/independent-admission/qlever-debian-signature-policy';
const root = path.resolve(__dirname, '../fixtures/independent-admission/debian-bookworm-keys');
const probe = JSON.parse(readFileSync(path.join(root, 'official-gpgv-status.json'), 'utf8')) as {keyringSha256: string; observations: {name: string; status: string; exit: number; inReleaseSha256: string; bodyBytes: number; bodySha256: string}[]};
const acquisition = Date.parse('2026-10-18T00:00:00Z');
it('binds exact official key originals and primary/signing packets to the independently executed Linux probe keyring', () => {
  const packets = DEBIAN_BOOKWORM_KEYS.map(policy => inspectDebianPublicKeyOriginal(readFileSync(path.join(root, policy.file)), policy));
  expect(createHash('sha256').update(Buffer.concat(packets)).digest('hex')).toBe(probe.keyringSha256);
  for (const policy of DEBIAN_BOOKWORM_KEYS) expect(() => inspectDebianPublicKeyOriginal(Buffer.from('metadata key approval'), policy)).toThrow('original differs');
});
it('accepts actual official three-suite gpgv originals with exact missing-key co-signatures, without authenticating unknown keys', () => {
  for (const row of probe.observations) {
    const original = readFileSync(path.join(root, row.name + '.InRelease.original'));
    expect(createHash('sha256').update(original).digest('hex')).toBe(row.inReleaseSha256);
    const body = extractDebianSignedRelease(original);
    expect(body.length).toBe(row.bodyBytes); expect(createHash('sha256').update(body).digest('hex')).toBe(row.bodySha256);
    const suite = inspectDebianReleaseSuite(body, acquisition, ['main/source/Sources']);
    const actual = inspectDebianGpgvStatus(Buffer.from(row.status), suite.role, acquisition, row.exit, true);
    expect(actual.signers.length > 0).toBe(true); expect(actual.nonAuthorityCoSignatures).toHaveLength(1);
    expect(DEBIAN_BOOKWORM_KEYS.some(key => key.primary === actual.nonAuthorityCoSignatures[0])).toBe(false);
    expect(suite.codename).toBe(row.name);
  }
});
it('rejects bad, expired, revoked, unmatched and status-only approvals, including exit/status mismatch', () => {
  const source = probe.observations[0]!.status;
  const changes = [source.replace('PLAINTEXT 74 0 ', 'PLAINTEXT 62 0 '), source.replace('PLAINTEXT 74 0 ', 'PLAINTEXT 74 0 name'), source.replace('[GNUPG:] NEWSIG', '[GNUPG:] PLAINTEXT 74 0 \n[GNUPG:] NEWSIG'), source + '[GNUPG:] BADSIG 6ED0E7B82643E131\n', source + '[GNUPG:] EXPSIG 6ED0E7B82643E131\n', source + '[GNUPG:] REVKEYSIG 6ED0E7B82643E131\n',
    source.replace(' 9 B8E5', ' 4 B8E5'), source.replace('NO_PUBKEY 78DBA3BC47EF2265', 'NO_PUBKEY 0000000000000000'), source.replace('GOODSIG 6ED0E7B82643E131', 'GOODSIG 0000000000000000'),
    source.replaceAll('B8B80B5B623EAB6AD8775C45B7C5D7D6350947F8', '0'.repeat(40)), source + '[GNUPG:] FAILURE arbitrary 1\n', source + '[GNUPG:] UNKNOWN ignored\n',
    '[GNUPG:] NEWSIG\n[GNUPG:] GOODSIG 6ED0E7B82643E131\n'];
  for (const status of changes) expect(() => inspectDebianGpgvStatus(Buffer.from(status), 'archive', acquisition, 2)).toThrow();
  expect(() => inspectDebianGpgvStatus(Buffer.from(source), 'archive', acquisition, 0)).toThrow('exit/status');
  expect(() => inspectDebianGpgvStatus(Buffer.from(source), 'security', acquisition, 2)).toThrow('reviewed');
  expect(() => inspectDebianGpgvStatus(Buffer.from(source), 'archive', Date.parse('2032-01-01'), 2)).toThrow('validity');
});
it('rejects unsigned trailing/concatenated text and wrong suite/component/time at the actual job', () => {
  const original = readFileSync(path.join(root, 'bookworm-security.InRelease.original'));
  for (const value of [Buffer.concat([original, Buffer.from('unsigned text')]), Buffer.concat([original, original]), Buffer.from(original.toString().replace('-----END PGP SIGNATURE-----', 'garbage\n-----END PGP SIGNATURE-----'))]) expect(() => extractDebianSignedRelease(value)).toThrow();
  const body = extractDebianSignedRelease(original);
  expect(() => inspectDebianReleaseSuite(Buffer.from(body.toString().replace('Label: Debian-Security', 'Label: Other')), acquisition, ['main/source/Sources'])).toThrow('suite');
  expect(() => inspectDebianReleaseSuite(body, acquisition, ['unknown/source/Sources'])).toThrow('component');
  expect(() => inspectDebianReleaseSuite(body, Date.parse('2026-10-25'), ['main/source/Sources'])).toThrow('valid');
  expect(() => inspectDebianReleaseSuite(body, Date.parse('2026-10-01'), ['main/source/Sources'])).toThrow('valid');
});
