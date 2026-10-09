import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { brotliCompressSync, constants } from 'node:zlib';
import * as esbuild from 'esbuild';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '../..');

describe('single-binary Task SDK', () => {
  it('loads the actual driver SDK adapter through the compiled Bun bootstrap', async () => {
    const parent = path.join(root, '.test-data/bun-single-task-sdk');
    fs.mkdirSync(parent, { recursive: true });
    const temporary = fs.mkdtempSync(path.join(parent, 'compiled-'));
    const stageRoot = path.join(temporary, 'package');
    try {
      const { stageRuntimeEsmPackages } = require('../../scripts/lib/runtime-esm-packages.cjs');
      const { createSingleBinaryEntry } = require('../../scripts/lib/bun-single-runtime-entry.cjs');
      await stageRuntimeEsmPackages({ nodeModulesRoot: path.join(root, 'node_modules'), stageRoot });
      // Exercise the real lazy loader without pulling unrelated service startup into
      // this packaging regression. Same AST extraction pattern as the logger test.
      const source = ts.createSourceFile('driver.ts', fs.readFileSync(path.join(root,
        'src/api/runs/PiAgentRuntimeDriver.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
      const driver = source.statements.find(value => ts.isClassDeclaration(value)
        && value.name?.text === 'PiAgentRuntimeDriver') as ts.ClassDeclaration;
      const loader = driver.members.find(value => ts.isMethodDeclaration(value)
        && ts.isIdentifier(value.name) && value.name.text === 'loadPiSdk');
      expect(loader).toBeDefined();
      const cli = await esbuild.transform(`
        const fs = require('node:fs'); const path = require('node:path');
        const { pathToFileURL } = require('node:url');
        const PACKAGE_ROOT = path.dirname(__dirname);
        class PiAgentRuntimeDriver { static sdkPromise; options = {}; ${loader!.getText(source)} }
        (async () => {
          const sdk = await new PiAgentRuntimeDriver().loadPiSdk();
          if (typeof sdk.createAgentSession !== 'function') throw new Error('SDK factory missing');
          console.log(JSON.stringify({ compiledLoader: true }));
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `, { loader: 'ts', format: 'cjs', target: 'node22' });
      fs.mkdirSync(path.join(stageRoot, 'dist'));
      fs.writeFileSync(path.join(stageRoot, 'dist/__cli__.cjs'), cli.code);
      const files = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true })
        .flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
      const manifest = files(stageRoot).map(file => ({ path: path.relative(stageRoot, file).split(path.sep).join('/'),
        contentBase64: fs.readFileSync(file).toString('base64'), mode: fs.statSync(file).mode & 0o777 }));
      const archive = brotliCompressSync(Buffer.from(JSON.stringify(manifest)), {
        params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
      });
      const entry = path.join(temporary, 'entry.ts');
      const binary = path.join(temporary, 'xpod-test');
      fs.writeFileSync(entry, createSingleBinaryEntry(createHash('sha256').update(archive).digest('hex'), archive));
      execFileSync('bun', ['build', '--compile', entry, '--outfile', binary], { timeout: 60_000, stdio: 'pipe' });
      const output = execFileSync(binary, [], { cwd: temporary, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, XPOD_BUN_SINGLE_CACHE_DIR: path.join(temporary, 'cache'), NODE_PATH: '' } });
      expect(JSON.parse(output.trim())).toEqual({ compiledLoader: true });
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }, 90_000);

  it('creates a real agent session using only the staged runtime dependencies', async () => {
    const parent = path.join(root, '.test-data/bun-single-task-sdk');
    fs.mkdirSync(parent, { recursive: true });
    const stageRoot = fs.mkdtempSync(path.join(parent, 'case-'));
    try {
      const { stageRuntimeEsmPackages } = require('../../scripts/lib/runtime-esm-packages.cjs');
      await stageRuntimeEsmPackages({ nodeModulesRoot: path.join(root, 'node_modules'), stageRoot });
      const output = execFileSync('node', ['--input-type=module', '-e', `
        import { registerHooks, isBuiltin } from 'node:module';
        import { fileURLToPath, pathToFileURL } from 'node:url';
        import path from 'node:path';
        const root = ${JSON.stringify(stageRoot)};
        registerHooks({ resolve(specifier, context, nextResolve) {
          const result = nextResolve(specifier, context);
          if (!isBuiltin(specifier) && result.url.startsWith('file:')
            && !fileURLToPath(result.url).startsWith(root + path.sep)) {
            throw new Error('Runtime dependency escaped the installed package: ' + specifier);
          }
          return result;
        } });
        const sdk = await import(pathToFileURL(path.join(root, 'node_modules/@mariozechner/pi-coding-agent/dist/index.js')));
        const cwd = path.join(root, 'workspace');
        for (const name of ['createCodingTools', 'createReadOnlyTools', 'createBashTool',
          'createEditTool', 'createReadTool', 'createWriteTool']) {
          if (!sdk[name](cwd)) throw new Error('Task tool factory is unavailable: ' + name);
        }
        const authStorage = sdk.AuthStorage.inMemory();
        const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir: path.join(root, 'agent'),
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
        await resourceLoader.reload();
        const { session } = await sdk.createAgentSession({ cwd, authStorage, resourceLoader,
          modelRegistry: new sdk.ModelRegistry(authStorage, path.join(root, 'agent/models.json')),
          settingsManager: sdk.SettingsManager.inMemory(), sessionManager: sdk.SessionManager.inMemory(cwd),
          tools: [], customTools: [], model: { id: 'fixture', name: 'fixture', provider: 'openai',
            api: 'openai-completions', baseUrl: 'https://example.invalid/v1', input: ['text'], reasoning: false,
            contextWindow: 1024, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } });
        if (!session.agent) throw new Error('Task agent session was not created');
        session.dispose();
        console.log(JSON.stringify({ imported: true, sessionCreated: true, isolated: true }));
      `], { cwd: stageRoot, encoding: 'utf8', timeout: 30_000, env: { ...process.env, NODE_PATH: '' } });
      expect(JSON.parse(output.trim())).toEqual({ imported: true, sessionCreated: true, isolated: true });
    } finally {
      fs.rmSync(stageRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
