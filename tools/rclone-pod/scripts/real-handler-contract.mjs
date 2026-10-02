// Starts the REAL TypeScript AgentDirectoryHttpHandler fixture, then runs the
// Go backend's List() against it to verify the backend speaks the real list
// contract (canonical same-origin root, pathPrefix without trailing slash,
// denied-resource exclusion). Writes raw evidence to the ignored fixture dir.
//
// Usage: bun tools/rclone-pod/scripts/real-handler-contract.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const work = path.join(repo, '.test-data/agent-directory-workers/rclone');
const fixtureRoot = path.join(work, 'real-handler-fixture');
rmSync(fixtureRoot, { recursive: true, force: true });
mkdirSync(path.join(fixtureRoot, 'sub'), { recursive: true });
mkdirSync(path.join(fixtureRoot, 'denied'), { recursive: true });
writeFileSync(path.join(fixtureRoot, 'alpha.txt'), 'alpha body\n');
writeFileSync(path.join(fixtureRoot, 'sub/beta.txt'), 'beta body\n');
writeFileSync(path.join(fixtureRoot, 'denied/secret.txt'), 'secret body\n');

const helperURL = pathToFileURL(path.join(repo, 'tests/helpers/agent-directory/fixtureServer.ts')).href;
const { startFixtureServer } = await import(helperURL);

const server = await startFixtureServer({
  fixtureDir: fixtureRoot,
  deniedPaths: ['denied/secret.txt'],
});

const log = [];
log.push(`# real AgentDirectoryHttpHandler contract probe`);
log.push(`podRoot=${server.podRoot}`);
log.push(`deniedPaths=denied/secret.txt`);

// Raw independent HTTP request against the real handler list endpoint.
const listURL = new URL('/-/agent-directory/list', server.origin);
listURL.searchParams.set('root', server.podRoot);
const raw = await fetch(listURL);
log.push(`\n## raw GET ${listURL.pathname}${listURL.search}`);
log.push(`status=${raw.status}`);
log.push(`body=${await raw.text()}`);

log.push(`\n## Go backend List() against the real handler`);
// IMPORTANT: use async spawn, not spawnSync. The fixture server runs in this
// process; a synchronous child would block the event loop and starve the
// handler until the Go client times out.
const goTest = await new Promise((resolve) => {
  const child = spawn(
    'go',
    ['test', '-run', 'TestRealAgentDirectoryHandlerList', '-count=1', '-v', './podhttp/'],
    {
      cwd: path.join(repo, 'tools/rclone-pod'),
      env: { ...process.env, XPOD_REAL_FIXTURE_URL: server.podRoot, GOPROXY: 'https://proxy.golang.org,direct' },
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (code) => resolve({ status: code, stdout, stderr }));
});
log.push(`exit=${goTest.status}`);
log.push(goTest.stdout);
log.push(goTest.stderr);

writeFileSync(path.join(work, 'real-handler-contract.log'), log.join('\n'));
await server.close();
console.log(`wrote ${path.join(work, 'real-handler-contract.log')}`);
process.exit(goTest.status ?? 1);
