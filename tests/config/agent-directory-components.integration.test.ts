import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ComponentsManager } from 'componentsjs';
import { DataFactory } from 'rdf-data-factory';
import { afterAll, describe, expect, it } from 'vitest';
import { createCssChildRuntimeConfig } from '../../src/runtime/css-process';
import { configuredHttpHandlerIds, LDP_HANDLER } from '../helpers/configuredHttpHandlerIds';

const AGENT_DIRECTORY_HANDLER = 'urn:undefineds:xpod:AgentDirectoryHttpHandler';

const runtimeRoots: string[] = [];

afterAll(() => {
  for (const root of runtimeRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('agent directory handler loads in every runtime profile', () => {
  it.each([
    [ 'local', 'config/local.json' ],
    [ 'cloud', 'config/cloud.json' ],
  ])('instantiates the handler and composes it before LDP in %s', async(_name, configPath) => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-agent-directory-'));
    runtimeRoots.push(runtimeRoot);
    const runtimeConfig = createCssChildRuntimeConfig({
      configPath: path.resolve(configPath),
      runtimeRoot,
      authMode: 'acp',
      externalOidcIssuer: 'https://id-rc.undefineds.co/',
    });
    const manager = await ComponentsManager.build({
      mainModulePath: process.cwd(),
      logLevel: 'error',
      typeChecking: false,
    });
    await manager.configRegistry.register(runtimeConfig.configPath);

    const factory = new DataFactory();
    const handler = manager.configRegistry.getInstantiatedResource(factory.namedNode(AGENT_DIRECTORY_HANDLER));
    expect(handler).toBeDefined();

    const handlers = configuredHttpHandlerIds(manager);
    const directoryIndex = handlers.indexOf(AGENT_DIRECTORY_HANDLER);
    const ldpIndex = handlers.indexOf(LDP_HANDLER);
    expect(directoryIndex).toBeGreaterThanOrEqual(0);
    expect(ldpIndex).toBeGreaterThan(directoryIndex);
  }, 60_000);
});
