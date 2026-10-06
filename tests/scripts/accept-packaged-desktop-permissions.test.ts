import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { acceptPackagedDesktopPermissions, assertOwnedTaskRows, safeFailureDetail } from '../../scripts/accept-packaged-desktop-permissions';

it('redacts credentials, account identity and callback queries from loggable failure detail', () => {
  expect(safeFailureDetail('Bearer eyJhbGciOi.payload.sig leaked')).toBe('Bearer <redacted> leaked');
  expect(safeFailureDetail('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature')).toBe('jwt <redacted-jwt>');
  expect(safeFailureDetail('key sk-live-abcdefghij rejected')).toBe('key sk-<redacted> rejected');
  expect(safeFailureDetail('account desktop-permission-1@example.test failed')).toBe('account <redacted-email> failed');
  expect(safeFailureDetail('callback https://id-rc.example/auth/callback?code=abc&state=xyz did not finish'))
    .toBe('callback https://id-rc.example/auth/callback did not finish');
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
    expect(safe.errors[0].message).toBe('Invalid source SHA');
    expect((await stat(safeFile)).mode & 0o777).toBe(0o644);
    await expect(readFile(evidenceFile)).rejects.toHaveProperty('code', 'ENOENT');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
