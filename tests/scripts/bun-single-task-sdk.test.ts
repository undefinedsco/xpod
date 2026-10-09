import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '../..');

describe('single-binary Task SDK', () => {
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
