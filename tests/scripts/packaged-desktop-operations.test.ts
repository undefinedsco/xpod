import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { accountCreationResponseSucceeded, assertAccountCredentialsRestored, assertNewAccountCredential, assertMountedModelBinding, readOwnedPiConfiguration } from '../../scripts/helpers/packaged-desktop-operations';

it.each([200, 201])('recognizes an Account creation success %s without requiring 201', status => {
  expect(accountCreationResponseSucceeded(status, 'CSS-Account-Token fixture')).toBe(true);
});

it('requires the Pod record to name the unique newly issued Account credential', () => {
  assertNewAccountCredential(['original'], [{ clientId: 'original' }, { clientId: 'new' }], 'new');
  expect(() => assertNewAccountCredential(['original'], [{ clientId: 'original' }], 'original')).toThrow('newly issued');
  expect(() => assertNewAccountCredential(['original'], [{ clientId: 'original' }], 'new')).toThrow('newly issued');
  expect(() => assertNewAccountCredential(['original'], [{ clientId: 'new' }, { clientId: 'unrelated' }], 'new')).toThrow('newly issued');
});

it('rejects failed or non-Account issuance and independently detects an orphan after Pod registration fails', () => {
  expect(accountCreationResponseSucceeded(401, 'CSS-Account-Token fixture')).toBe(false);
  expect(accountCreationResponseSucceeded(200, 'Bearer fixture')).toBe(false);
  assertAccountCredentialsRestored(['original'], [{ clientId: 'original' }]);
  expect(() => assertAccountCredentialsRestored(['original'], [{ clientId: 'original' }, { clientId: 'orphan' }])).toThrow('Account credential');
});

it('matches the actual discovery credential, selected model and published provider without accepting another row', () => {
  const input = { provider: 'deepseek' as const, credentialId: 'new', model: 'deepseek-flash', webId: 'https://id.example/card#me' };
  const result = { credential: { id: 'new', provider: 'deepseek' }, credentialCount: 1, providerId: 'deepseek', webId: input.webId,
    discovery: { provider: 'deepseek', credential: 'new', models: [{ id: input.model }] },
    models: [{ id: input.model, provider: 'deepseek', availability: 'available' }] };
  assertMountedModelBinding(input, result);
  for (const changed of [{ ...result, credentialCount: 2 },
    { ...result, discovery: { ...result.discovery, credential: 'old' } },
    { ...result, models: [{ ...result.models[0], id: 'different' }] },
    { ...result, models: [{ ...result.models[0], provider: 'foreign' }] },
    { ...result, webId: input.webId.replace('#me', '#other') }]) {
    expect(() => assertMountedModelBinding(input, changed)).toThrow('binding');
  }
});

it('requires actual Pi files in the owned home and refuses foreign paths or gateway configuration', async () => {
  const root = path.join(process.cwd(), '.test-data', 'packaged-desktop-operations');
  await mkdir(root, { recursive: true });
  const fixture = await mkdtemp(path.join(root, 'config-'));
  const home = path.join(fixture, 'owned-home');
  const files = path.join(home, '.pi', 'agent');
  const outside = path.join(fixture, 'outside-settings.json');
  await mkdir(files, { recursive: true });
  const models = path.join(files, 'models.json');
  const settings = path.join(files, 'settings.json');
  const gateway = 'http://127.0.0.1:41234/';
  const projection = { providers: { xpod: { baseUrl: `${gateway}v1`, apiKey: 'fixture-private-wrapper' } } };
  try {
    await writeFile(models, JSON.stringify(projection), { mode: 0o600 });
    await writeFile(settings, JSON.stringify({ defaultProvider: 'xpod' }), { mode: 0o600 });
    expect(await readOwnedPiConfiguration(home, gateway)).toBe('fixture-private-wrapper');
    expect((await lstat(models)).mode & 0o077).toBe(0);
    await expect(readOwnedPiConfiguration(home, 'http://127.0.0.1:41235/')).rejects.toThrow('differs');
    await writeFile(outside, JSON.stringify({ defaultProvider: 'xpod' }));
    const original = await readFile(outside, 'utf8');
    await rm(settings);
    await symlink(outside, settings);
    await expect(readOwnedPiConfiguration(home, gateway)).rejects.toThrow('escaped');
    expect(await readFile(outside, 'utf8')).toBe(original);
    await rm(settings);
    await writeFile(settings, JSON.stringify({ defaultProvider: 'foreign' }));
    await expect(readOwnedPiConfiguration(home, gateway)).rejects.toThrow('differs');
    await rm(models);
    await expect(readOwnedPiConfiguration(home, gateway)).rejects.toThrow();
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
