import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { c as packTar } from 'tar';
import { ModuleStore } from '../src/module-store';
import { startCommand } from '../src/commands/start';
import { nodeRuntimeHost } from '../../../src/runtime/host/node/NodeRuntimeHost';

for (const mode of ['local', 'cloud'] as const) test(`installed start selects ${mode} for both children and retains leases through HTTP stop`, async () => {
  const parent = path.resolve('.test-data/cli-start'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'case-'));
  const previous = process.env.XPOD_EDITION;
  process.env.XPOD_EDITION = mode === 'cloud' ? 'local' : 'cloud';
  const archives = new Map<string, Buffer>();
  try {
    for (const id of ['css', 'api']) {
      const input = path.join(root, id, 'package'); await mkdir(path.join(input, 'config'), { recursive: true });
      const files: Array<{ path: string; sha256: string; size: number; mode: number }> = [];
      const source = `import http from 'node:http'; const server=http.createServer((req,res)=>res.end(req.url.includes('layout')?JSON.stringify({cwd:process.cwd(),identity:process.env.CSS_IDENTITY_DB_URL,index:process.env.CSS_RDF_INDEX_PATH}):${JSON.stringify(id)}+':'+process.env.XPOD_EDITION)); server.listen(Number(process.env.${id === 'css' ? 'CSS_PORT' : 'API_PORT'}),'127.0.0.1'); process.on('SIGTERM',()=>server.close()); process.on('SIGINT',()=>server.close());`;
      for (const [name, bytes] of [['entry.mjs', source], ['config/local.json', '{}'], ['config/cloud.json', '{}']]) {
        await writeFile(path.join(input, name), bytes); await chmod(path.join(input, name), 0o644);
        files.push({ path: name, sha256: createHash('sha256').update(bytes).digest('hex'), size: Buffer.byteLength(bytes), mode: 0o644 });
      }
      await writeFile(path.join(input, 'package.json'), JSON.stringify({ name: `@undefineds.co/xpod-${id}-darwin-arm64`, version: '0.1.0',
        xpodModule: { schemaVersion: 1, id, cliApiVersion: 1, platform: 'darwin', arch: 'arm64', entry: 'entry.mjs', files } }));
      const archive = path.join(root, `${id}.tgz`); await packTar({ cwd: path.dirname(input), file: archive, gzip: true }, ['package']);
      archives.set(id, await readFile(archive));
    }
    const request = (async (input: string | URL | Request) => {
      const url = decodeURIComponent(String(input)); const id = url.includes('xpod-css') || url.endsWith('/css.tgz') ? 'css' : 'api';
      const bytes = archives.get(id)!;
      if (url.endsWith('.tgz')) return new Response(bytes);
      return Response.json({ name: `@undefineds.co/xpod-${id}-darwin-arm64`, version: '0.1.0',
        dist: { integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, tarball: `https://registry.npmjs.org/${id}.tgz` } });
    }) as typeof fetch;
    const store = new ModuleStore({ root: path.join(root, 'store'), platform: 'darwin', arch: 'arm64', fetch: request });
    const ports = await nodeRuntimeHost.allocatePorts();
    const base = `http://localhost:${ports.gateway}`;
    const handler = startCommand(store).handler as (argv: any) => Promise<void>;
    let settled = false;
    const execution = handler({ modules: ['css', 'api'], mode, host: '127.0.0.1', port: ports.gateway, data: path.join(root, 'data'), baseUrl: base }).finally(() => { settled = true; });
    try {
      let ready = false;
      for (let i = 0; i < 200 && !settled; i++) {
        try { if ((await fetch(base + '/resource')).status === 200) { ready = true; break; } } catch {}
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(ready).toBe(true);
      expect(await (await fetch(base + '/resource')).text()).toBe(`css:${mode}`);
      expect(await (await fetch(base + '/v1/models')).text()).toBe(`api:${mode}`);
      const cssLayout = await (await fetch(base + '/layout')).json();
      const apiLayout = await (await fetch(base + '/v1/layout')).json();
      expect(cssLayout).toEqual(apiLayout);
      expect(cssLayout.cwd).toBe(path.join(root, 'data'));
      expect(cssLayout.identity).toBe(`sqlite:${path.join(root, 'data/identity.sqlite')}`);
      expect(cssLayout.index).toBe(path.join(root, 'data/rdf-index.sqlite'));
      expect(await store.remove('css').then(() => null, cause => cause.code)).toBe('module_busy');
      expect(await store.remove('api').then(() => null, cause => cause.code)).toBe('module_busy');
      expect((await fetch(base + '/service/stop', { method: 'POST' })).status).toBe(202);
      await execution;
      expect((await store.current('css'))?.version).toBe('0.1.0');
      expect((await store.current('api'))?.version).toBe('0.1.0');
      await store.remove('css'); await store.remove('api');
    } finally {
      if (!settled) process.emit('SIGTERM');
      await execution;
    }
  } finally {
    if (previous === undefined) delete process.env.XPOD_EDITION; else process.env.XPOD_EDITION = previous;
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
