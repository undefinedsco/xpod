import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

interface ConfigGraph {
  '@graph': Array<Record<string, unknown>>;
}

async function loadConfig(configPath: string): Promise<ConfigGraph> {
  return JSON.parse(await readFile(configPath, 'utf8')) as ConfigGraph;
}

describe('agent directory HTTP handler registration', () => {
  it('defines the handler once in the shared base config', async() => {
    const config = await loadConfig('config/xpod.base.json');
    const definition = config['@graph'].find((entry) => entry['@id'] === 'urn:undefineds:xpod:AgentDirectoryHttpHandler');
    expect(definition).toBeDefined();
    expect(definition).toMatchObject({
      '@type': 'AgentDirectoryHttpHandler',
      accessor: { '@id': 'urn:undefineds:xpod:MixDataAccessor' },
      credentialsExtractor: { '@id': 'urn:solid-server:default:CredentialsExtractor' },
      permissionReader: { '@id': 'urn:solid-server:default:PermissionReader' },
      authorizer: { '@id': 'urn:solid-server:default:Authorizer' },
      auxiliaryStrategy: { '@id': 'urn:solid-server:default:AuxiliaryStrategy' },
      identifierStrategy: { '@id': 'urn:solid-server:default:IdentifierStrategy' },
    });
  });

  it.each([
    [ 'local', 'config/local.json' ],
    [ 'cloud', 'config/cloud.json' ],
  ])('references the handler in the %s HTTP pipeline', async(_name, configPath) => {
    const config = await loadConfig(configPath);

    const pipeline = config['@graph'].find((entry) => {
      const instance = entry.overrideInstance as { '@id'?: string } | undefined;
      return instance?.['@id'] === 'urn:solid-server:default:BaseHttpHandler';
    });
    const handlers = (pipeline?.overrideParameters as { handlers?: Array<{ '@id': string }> } | undefined)?.handlers ?? [];
    const ids = handlers.map((handler) => handler['@id']);
    expect(ids).toContain('urn:undefineds:xpod:AgentDirectoryHttpHandler');
    // The sidecar must be reachable before the generic LDP handler consumes the path.
    expect(ids.indexOf('urn:undefineds:xpod:AgentDirectoryHttpHandler'))
      .toBeLessThan(ids.indexOf('urn:solid-server:default:LdpHandler'));
  });
});
