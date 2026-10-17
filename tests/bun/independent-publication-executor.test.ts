import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { runPublicationCommand } = createRequire(import.meta.url)('../../scripts/lib/afs-publication-command.cjs');
import { executeIndependentPublication, promoteIndependentPublication, normalizeIndependentDistTags } from '../../scripts/lib/independent-admission/publication-executor';

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

describe('dist-tag evidence and fixed Bun credential mode', () => {
  test('mapping preserves only canonical npm tag/version pairs', () => {
    expect(JSON.stringify(normalizeIndependentDistTags({ next: '1.2.3-rc.1', latest: '1.2.2' })))
      .toBe('{"latest":"1.2.2","next":"1.2.3-rc.1"}');
    for (const value of [{}, [], { message: '1.2.3' }, { latest: 'token-bearing-error' },
      { '1.0': '1.0.0' }, { next: 'v1.2.3' }, { next: '1.2.3', token: '1.0.0' },
      Object.fromEntries(Array.from({ length: 129 }, (_, i) => ['tag' + i, '1.0.0']))]) {
      expect(() => normalizeIndependentDistTags(value)).toThrow();
    }
  });
  test('actual Bun publish uses NPM_CONFIG_TOKEN at exact loopback registry', async () => {
    // This isolated protocol fixture never calls a production publication entry.
    const root = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'publisher-auth-'));
    const observed: { method: string; authorized: boolean; bytes: number }[] = [];
    let oversized = false;
    const fixtureToken = 'fixture-only-no-real-credential';
    const server = http.createServer((request, response) => {
      const address = server.address();
      const exactHost = typeof address === 'object' && address ? '127.0.0.1:' + address.port : '';
      if (request.headers.host !== exactHost || request.url !== '/xpod-auth-fixture' || request.method !== 'PUT') {
        response.writeHead(400).end('{}'); request.resume(); return;
      }
      let bytes = 0;
      request.on('data', chunk => { bytes += chunk.length; if (bytes > 256 * 1024) { oversized = true; request.destroy(); } });
      request.on('end', () => {
        const authorized = request.headers.authorization === 'Bearer ' + fixtureToken;
        observed.push({ method: request.method!, authorized, bytes });
        response.writeHead(authorized ? 201 : 401, { 'content-type': 'application/json' });
        response.end('{}');
      });
    });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address(); if (!address || typeof address === 'string') throw Error('loopback fixture unavailable');
      const registry = 'http://127.0.0.1:' + address.port + '/';
      for (const directory of ['package', 'home', 'tmp', 'evidence']) fs.mkdirSync(path.join(root, directory));
      const manifest = JSON.stringify({ name: 'xpod-auth-fixture', version: '0.0.0', license: 'MIT' });
      // Bun initializes the invocation cwd even when publishing an explicit tarball.
      // Keep the fixture independent of an accidental repository parent manifest.
      fs.writeFileSync(path.join(root, 'package.json'), manifest);
      fs.writeFileSync(path.join(root, 'package', 'package.json'), manifest);
      const archive = path.join(root, 'fixture.tgz');
      execFileSync('tar', ['-czf', archive, '-C', root, 'package'], { timeout: 1000, maxBuffer: 4096 });
      const config = path.join(root, '.npmrc'); fs.writeFileSync(config, 'registry=' + registry + '\n', { mode: 0o600 });
      const executable = fs.realpathSync(process.execPath);
      expect(Boolean(process.versions.bun)).toBe(true);
      const env = { PATH: path.dirname(executable), HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'),
        NPM_CONFIG_USERCONFIG: config, NPM_CONFIG_GLOBALCONFIG: config, NPM_CONFIG_TOKEN: fixtureToken, LANG: 'C.UTF-8' };
      expect('NODE_AUTH_TOKEN' in env).toBe(false);
      const row = await runPublicationCommand(executable, ['publish', archive, '--ignore-scripts', '--registry=' + registry,
        '--access', 'public', '--tag', 'xpod-candidate-fixture'],
      { cwd: root, env, evidence: path.join(root, 'evidence'), label: 'fixture-auth', timeoutMs: 2500, rawLimit: 16 * 1024 });
      expect([row.code, row.actualWait, row.actualClose, row.groupAbsent, row.rawComplete, row.rawClosedBeforeHash]).toEqual([0, true, true, true, true, true]);
      expect(row.pipeEOF).toEqual([true, true]);
      expect(observed.length).toBe(1); expect(observed[0]?.authorized).toBe(true); expect(oversized).toBe(false);
      let written = 0;
      for (const entry of fs.readdirSync(root, { recursive: true })) {
        const file = path.join(root, String(entry)); const stat = fs.statSync(file);
        if (stat.isFile()) { written += stat.size; expect(fs.readFileSync(file).includes(Buffer.from(fixtureToken))).toBe(false); }
      }
      expect(written < 1024 * 1024).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 5000);
});
