import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import { executeIndependentPublication, promoteIndependentPublication } from '../../scripts/lib/independent-admission/publication-executor';

describe('guarded independent publication executor', () => {
  test('JSON passed claims fail before disk writes or network', async () => {
    const before = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('xpod-independent-publish-')).sort();
    const fake = { status: 'verified', allProfilesVerified: true, stage: 'prepublish' };
    await expect(executeIndependentPublication({ client: fake, cli: fake, clientSource: fake,
      cliSource: fake, clientConsumer: fake, cliConsumer: fake, token: 'never-used' })).rejects.toThrow('real central');
    expect(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('xpod-independent-publish-')).sort()).toEqual(before);
  });
  test('serialized or absent permits cannot promote tags', async () => {
    for (const permit of [undefined, {}, { tagPromotion: { status: 'eligible' }, used: false }]) {
      await expect(promoteIndependentPublication(permit, 'never-used')).rejects.toThrow('real unused promotion permit');
    }
  });
});
