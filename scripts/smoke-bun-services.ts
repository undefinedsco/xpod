import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getFreePort } from '../src/runtime/port-finder';

// Exercise the real supervised CLI, not the in-process integration fixture.
const repo = path.resolve(import.meta.dir, '..');
const parent = path.join(repo, '.test-data', 'bun-services');
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, 'run-'));
const port = await getFreePort(18_400 + Math.floor(Math.random() * 5_000), '127.0.0.1');
const baseUrl = `http://127.0.0.1:${port}/`;
const binary = process.argv[2];
const command = binary ? path.resolve(binary) : process.execPath;
const args = binary ? [] : ['--no-env-file', path.join(repo, 'src/cli/index.ts')];
const child = spawn(command, [...args, 'start', '--mode', 'local', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: root,
  env: {
    // No system Node/Bun lookup: the service must reuse its absolute executable.
    PATH: '/usr/bin:/bin',
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    CSS_BASE_URL: baseUrl,
    SOLID_OIDC_ISSUER: baseUrl,
    CSS_IDENTITY_DB_URL: `sqlite:${root}/identity.sqlite`,
    CSS_RDF_INDEX_PATH: `${root}/rdf.sqlite`,
    CSS_SPARQL_ENDPOINT: `sqlite:${root}/quadstore.sqlite`,
    CSS_ROOT_FILE_PATH: `${root}/data`,
    XPOD_AUTH_MODE: 'open',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (chunk) => { log += chunk; });
child.stderr.on('data', (chunk) => { log += chunk; });
const closed = once(child, 'close');
try {
  let ready = false;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`service exited: ${child.exitCode}`);
    if (log.includes('Fatal error:') || log.includes('exceeded max restarts')) throw new Error('child service failed');
    try {
      const response = await fetch(new URL('.well-known/openid-configuration', baseUrl), { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const discovery = await response.json();
        if (discovery.issuer !== baseUrl) throw new Error('unexpected issuer');
        const status = await fetch(new URL('service/status', baseUrl), { signal: AbortSignal.timeout(1_000) });
        if (status.ok) { ready = true; break; }
      }
    } catch { /* Wait for CSS and API startup. */ }
    await Bun.sleep(250);
  }
  if (!ready) throw new Error('Bun service startup timed out');
  if (log.includes('exited with code') || log.includes('spawn node')) throw new Error('unexpected service restart or Node launch');
  console.log(`[bun-services] ready: ${baseUrl} (${binary ? 'compiled binary' : 'Bun source CLI'})`);
} catch (error) {
  await fs.writeFile(path.join(root, 'startup.log'), log);
  throw new Error(`${error}; startup evidence: ${root}/startup.log`);
} finally {
  child.kill('SIGTERM');
  await Promise.race([closed, Bun.sleep(5_000).then(() => child.kill('SIGKILL'))]);
}
