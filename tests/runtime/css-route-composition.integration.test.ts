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
  it('keeps Cloud Account creation on the React identity surface', () => {
    const cloudConfig = JSON.parse(fs.readFileSync(path.resolve('config/cloud.json'), 'utf8')) as {
      '@graph'?: Array<{ overrideInstance?: { '@id'?: string } }>;
    };

    expect(cloudConfig['@graph'] ?? []).not.toContainEqual(expect.objectContaining({
      overrideInstance: { '@id': 'urn:solid-server:default:CreatePodHtml' },
    }));
    expect(fs.existsSync(path.resolve('templates/identity/account/create-pod.html.ejs'))).toBe(false);
  });

  it('persists Cloud account identity records through DrizzleIndexedStorage', () => {
    const cloudConfig = JSON.parse(fs.readFileSync(path.resolve('config/cloud.json'), 'utf8')) as {
      '@graph'?: Array<{
        overrideInstance?: { '@id'?: string };
        overrideParameters?: {
          '@type'?: string;
          storage?: {
            '@type'?: string;
            connectionString?: { '@id'?: string };
          };
        };
      }>;
    };
    const accountStorageOverride = (cloudConfig['@graph'] ?? []).find((entry) =>
      entry.overrideInstance?.['@id'] === 'urn:solid-server:default:AccountStorage');

    expect(accountStorageOverride?.overrideParameters?.['@type']).toBe('LoginMethodGuardStorage');
    expect(accountStorageOverride?.overrideParameters?.storage).toMatchObject({
      '@type': 'DrizzleIndexedStorage',
      connectionString: {
        '@id': 'urn:solid-server:default:variable:identityDbUrl',
      },
    });
  });

  it('composes the route chain without the deleted internal Pod-data handler after auth config is composed', async() => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-css-routes-'));
    const runtimeConfig = createCssChildRuntimeConfig({
      configPath: path.resolve('config/cloud.json'),
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

    const resource = manager.configRegistry.getInstantiatedResource(
      new DataFactory().namedNode(BASE_HTTP_HANDLER),
    );
    if (!resource) throw new Error('Base HTTP handler config was not instantiated');
    const constructorPool = manager.configConstructorPool as typeof manager.configConstructorPool & {
      getRawConfig(value: typeof resource): {
        properties: Record<string, Array<{ list?: Array<{ list?: Array<{ value: string }> }> }>>;
      };
    };
    const constructed = constructorPool.getRawConfig(resource);
    const constructorArguments = constructed?.properties[
      'https://linkedsoftwaredependencies.org/vocabularies/object-oriented#arguments'
    ]?.[0]?.list;
    const handlers = constructorArguments?.[0]?.list?.map((entry) => entry.value);

    expect(handlers).toBeDefined();
    // The privileged internal Pod-data channel is deleted end to end: it must not be
    // composed into the handler chain, nor be instantiable from the composed config.
    expect(handlers).not.toContain(INTERNAL_POD_DATA_HANDLER);
    expect(manager.configRegistry.getInstantiatedResource(
      new DataFactory().namedNode(INTERNAL_POD_DATA_HANDLER),
    )).toBeUndefined();

    // The Xpod sidecar route that used to sit behind it still precedes the CSS routes.
    const sidecarIndex = handlers?.indexOf('urn:undefineds:xpod:SubgraphSparqlHttpHandler') ?? -1;
    const cssRouteIndex = handlers?.indexOf('urn:solid-server:default:LdpHandler') ?? -1;
    expect(sidecarIndex).toBeGreaterThanOrEqual(0);
    expect(cssRouteIndex).toBeGreaterThan(sidecarIndex);
  }, 30_000);
});
