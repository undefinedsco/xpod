import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { acceptPackagedDesktopPermissions, assertOwnedTaskRows, DesktopAcceptanceError, describeFailure,
  publishedFailures } from '../../scripts/accept-packaged-desktop-permissions';
import { OidcApprovalError } from '../../tests/helpers/browserSolidOidc';

it('publishes only reviewed failure codes and never the underlying error text', () => {
  // An arbitrary upstream error can carry provider keys, opaque tokens or an
  // assertion/credential dump; the public projection must degrade to the
  // generic code and expose none of it. Regex scrubbing is deliberately not the
  // safety mechanism here.
  const secrets = [
    'oc_sk_live_9f2c1d4b8a7e6f5c6d7e8f90',
    'opaque-refresh-token-2f8c1d4b8a7e6f5c6d7e8f90a1b2',
    '{"apiKey":"json-secret-value","assertion":"signed-dump","cookie":"sid=abc"}',
  ];
  for (const secret of secrets) {
    const published = describeFailure(new Error(`upstream rejected ${secret}`));
    expect(published.code).toBe('unclassified');
    expect(JSON.stringify(published)).not.toContain(secret);
    expect(JSON.stringify(publishedFailures([new Error(secret), secret]))).not.toContain(secret);
  }
  // A typed failure publishes its reviewed code and explanation, never its
  // private detail; duplicate codes collapse to one entry.
  const typed = new DesktopAcceptanceError('local-authority', 'private detail with oc_sk_live_9f2c1d4b8a7e6f5c');
  expect(describeFailure(typed)).toEqual({ code: 'local-authority',
    explanation: 'The packaged Local authority or no-public-route proof was missing' });
  expect(JSON.stringify(describeFailure(typed))).not.toContain('oc_sk_live_9f2c1d4b8a7e6f5c');
  expect(publishedFailures([typed, typed])).toEqual([{ code: 'local-authority',
    explanation: 'The packaged Local authority or no-public-route proof was missing' }]);
});

it('publishes only the closed-vocabulary sub-condition the remember gate actually failed', () => {
  // The remember gate is the only reviewed code with a sub-condition. It is a
  // fixed token set, so a CI log/artifact can name which part of the gate failed
  // without ever publishing the private trace booleans behind it.
  const offered = new DesktopAcceptanceError('remember-grant',
    'requested=undefined observed=undefined posted=false with oc_sk_live_9f2c1d4b8a7e6f5c', 'choice-not-offered');
  expect(describeFailure(offered)).toEqual({ code: 'remember-grant',
    explanation: 'The remembered-grant bootstrap did not retain the explicit remember-client choice',
    evidence: 'choice-not-offered' });
  expect(JSON.stringify(describeFailure(offered))).not.toContain('oc_sk_live_9f2c1d4b8a7e6f5c');
  expect(JSON.stringify(describeFailure(offered))).not.toContain('observed=');
  // A bare duplicate code must never replace the entry that carries the
  // sub-condition, and the arbitrary error text stays private.
  expect(publishedFailures([offered, new DesktopAcceptanceError('remember-grant', 'raw-private-detail')]))
    .toEqual([{ code: 'remember-grant',
      explanation: 'The remembered-grant bootstrap did not retain the explicit remember-client choice',
      evidence: 'choice-not-offered' }]);
  // Every other reviewed code stays exactly as reviewed: no sub-condition.
  expect(describeFailure(new DesktopAcceptanceError('consent-binding', 'private'))).toEqual({
    code: 'consent-binding', explanation: 'The actual browser callback or exact Consent binding proof was missing' });
});

it('names the failing browser approval operation with a reviewed code and closed token', () => {
  // RC run 37446580517 failed at pod-a with the generic `unclassified` code: the
  // browser approval helper threw a plain Error, so neither the stdout
  // projection nor the artifact could name the operation. Every approval
  // failure must now publish a reviewed code plus a closed-vocabulary token.
  const blocked = new OidcApprovalError('choice-disabled',
    'Consent remember-client choice is disabled with oc_sk_live_9f2c1d4b8a7e6f5c');
  expect(describeFailure(blocked)).toEqual({ code: 'oidc-approval',
    explanation: 'The packaged browser approval step failed; the reviewed sub-condition names the operation',
    evidence: 'choice-disabled' });
  expect(JSON.stringify(describeFailure(blocked))).not.toContain('oc_sk_live_9f2c1d4b8a7e6f5c');
  expect(publishedFailures([new Error('unclassified upstream'), blocked]))
    .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'oidc-approval', evidence: 'choice-disabled' })]));
  for (const condition of ['choice-not-offered', 'choice-not-retained', 'binding-not-retained', 'binding-unavailable',
    'webid-unavailable', 'multiple-webids', 'second-login-action', 'recovery-boundary', 'login-timeout',
    'account-remember'] as const) {
    expect(describeFailure(new OidcApprovalError(condition, 'private detail'))).toEqual({ code: 'oidc-approval',
      explanation: 'The packaged browser approval step failed; the reviewed sub-condition names the operation',
      evidence: condition });
  }
});

it('requires actual independent A task rows and refuses any rows in fresh B', () => {
  assertOwnedTaskRows({ tasks: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }] }, ['a1', 'a2', 'a3']);
  assertOwnedTaskRows({ tasks: [] }, [], true);
  expect(() => assertOwnedTaskRows({ tasks: [] }, ['a1', 'a2', 'a3'])).toThrow('isolation');
  expect(() => assertOwnedTaskRows({ tasks: [{ id: 'a1' }] }, [], true)).toThrow('isolation');
  expect(() => assertOwnedTaskRows({}, [], true)).toThrow('isolation');
});

it('retains the original failing stage and cannot emit public evidence from an invalid source', async () => {
  const parent = path.join(process.cwd(), '.test-data', 'packaged-desktop-runner');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'failed-'));
  const evidenceFile = path.join(directory, 'public.json');
  try {
    await expect(acceptPackagedDesktopPermissions({ archive: 'absent', version: '0.4.26', sourceSha: 'invalid',
      issuer: 'https://id.example/', keyFile: 'absent', privateDirectory: directory, evidenceFile })).rejects.toThrow('private evidence retained');
    const failure = JSON.parse(await readFile(path.join(directory, 'failure-private.json'), 'utf8'));
    expect(failure.stage).toBe('input');
    // The redacted summary stays available for the workflow log/artifact even
    // though no public evidence was produced.
    const safeFile = path.join(directory, 'failure-safe.json');
    const safe = JSON.parse(await readFile(safeFile, 'utf8'));
    expect(safe).toMatchObject({ schemaVersion: 1, kind: 'desktop-permission-failure', version: '0.4.26', stage: 'input' });
    expect(safe.failures).toEqual([{ code: 'invalid-arguments',
      explanation: 'The packaged desktop runner arguments failed validation' }]);
    expect((await stat(safeFile)).mode & 0o777).toBe(0o644);
    await expect(readFile(evidenceFile)).rejects.toHaveProperty('code', 'ENOENT');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
