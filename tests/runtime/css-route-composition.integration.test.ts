import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ComponentsManager } from 'componentsjs';
import { DataFactory } from 'rdf-data-factory';
import { describe, expect, it } from 'vitest';
import { createCssChildRuntimeConfig } from '../../src/runtime/css-process';

const BASE_HTTP_HANDLER = 'urn:solid-server:default:BaseHttpHandler';
const INTERNAL_POD_DATA_HANDLER = 'urn:undefineds:xpod:InternalPodDataHttpHandler';

describe('CSS route composition', () => {
  it('keeps the Xpod internal Pod route ahead of the CSS routes after auth config is composed', async() => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-css-routes-'));
    const runtimeConfig = createCssChildRuntimeConfig({
      configPath: path.resolve('config/cloud.json'),
      runtimeRoot,
      authMode: 'acp',
    });
    const manager = await ComponentsManager.build({
      mainModulePath: process.cwd(),
      logLevel: 'error',
      typeChecking: false,
    });
    await manager.configRegistry.register(runtimeConfig.configPath);

    const resource = manager.configRegistry.getInstantiatedResource(
      new DataFactory().namedNode(BASE_HTTP_HANDLER),
    );
    const constructed = resource && manager.configConstructorPool.getRawConfig(resource);
    const constructorArguments = constructed?.properties[
      'https://linkedsoftwaredependencies.org/vocabularies/object-oriented#arguments'
    ]?.[0]?.list;
    const handlers = constructorArguments?.[0]?.list?.map((entry) => entry.value);

    expect(handlers?.[0]).toBe(INTERNAL_POD_DATA_HANDLER);
  }, 30_000);
});
