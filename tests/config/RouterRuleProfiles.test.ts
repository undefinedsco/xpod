import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CONFIG_DIR = path.resolve(process.cwd(), 'config');
const ROUTER_RULE_ID = 'urn:solid-server:default:RouterRule';
const BACKEND_STORE_ID = 'urn:solid-server:default:ResourceStore_Backend';

describe('RouterRule config profiles', () => {
  it.each([
    ['local.json', ['linx-model-settings.files.json']],
    ['local-pg.json', ['linx-model-settings.files.json']],
    ['cloud.json', ['router.sparql.json']],
    ['xpod.json', ['router.sparql.json']],
    ['bun.json', ['router.sparql.json']],
  ])('%s imports exactly one RouterRule override profile', (profile, expectedRouterProfiles) => {
    const imports = collectConfigImports(profile);
    const routerProfiles = imports.filter((fileName) => configOverridesRouterRule(fileName));

    expect(routerProfiles).toEqual(expectedRouterProfiles);
  });

  it('routes LinX app-owned data TTL resources to the file store in local profiles', () => {
    const routerRule = getRouterRule('linx-model-settings.files.json');

    expect(routerRule?.base?.['@id']).toBe('urn:solid-server:default:variable:baseUrl');
    expect(getRouterRuleRegexes(routerRule)).toEqual(expect.arrayContaining([
      '^/[^/]+/(\\.data|\\.data/chat|\\.data/agents|\\.data/contacts)/?$',
      '^/[^/]+/\\.data/chat/[^/]+\\.ttl$',
      '^/[^/]+/\\.data/agents/[^/]+\\.ttl$',
      '^/[^/]+/\\.data/contacts/[^/]+\\.ttl$',
    ]));
    expect(getRouterRuleRegexes(routerRule)).not.toEqual(expect.arrayContaining([
      '^/[^/]+/settings/credentials\\.ttl$',
      '^/[^/]+/settings/providers/[^/]+\\.ttl$',
    ]));
    expect(getRouterRuleStoreIds(routerRule)).toContain('urn:undefineds:xpod:SparqlQuadstoreResourceStore');
  });

  it.each(['local.json', 'local-pg.json'])('%s uses the RouterRule-backed resource store', (profile) => {
    const backendStore = getOverrideParameters(profile, BACKEND_STORE_ID);

    expect(backendStore?.['@type']).toBe('RoutingResourceStore');
    expect(backendStore?.rule?.['@id']).toBe(ROUTER_RULE_ID);
  });
});

function collectConfigImports(entryFile: string, seen = new Set<string>()): string[] {
  if (seen.has(entryFile)) return [];
  seen.add(entryFile);

  const document = readConfig(entryFile);
  const directImports = Array.isArray(document.import) ? document.import : [];
  const localImports = directImports
    .filter((item): item is string => typeof item === 'string' && item.startsWith('./'))
    .map((item) => item.slice(2));

  return [
    entryFile,
    ...localImports.flatMap((fileName) => collectConfigImports(fileName, seen)),
  ];
}

function configOverridesRouterRule(fileName: string): boolean {
  const graph = readConfig(fileName)['@graph'];
  if (!Array.isArray(graph)) return false;

  return graph.some((entry) => (
    entry
    && typeof entry === 'object'
    && (entry as Record<string, unknown>)['@type'] === 'Override'
    && ((entry as any).overrideInstance?.['@id']) === ROUTER_RULE_ID
  ));
}

function getRouterRule(fileName: string): any {
  return getOverrideParameters(fileName, ROUTER_RULE_ID);
}

function getOverrideParameters(fileName: string, overrideId: string): any {
  const graph = readConfig(fileName)['@graph'];
  if (!Array.isArray(graph)) return null;

  const override = graph.find((entry) => (
    entry
    && typeof entry === 'object'
    && (entry as Record<string, unknown>)['@type'] === 'Override'
    && ((entry as any).overrideInstance?.['@id']) === overrideId
  )) as any;

  return override?.overrideParameters ?? null;
}

function getRouterRuleRegexes(routerRule: any): string[] {
  const rules = routerRule?.rules;
  if (!Array.isArray(rules)) return [];
  return rules
    .map((rule) => rule?.regex)
    .filter((regex): regex is string => typeof regex === 'string');
}

function getRouterRuleStoreIds(routerRule: any): string[] {
  const rules = routerRule?.rules;
  if (!Array.isArray(rules)) return [];
  return rules
    .map((rule) => rule?.store?.['@id'])
    .filter((storeId): storeId is string => typeof storeId === 'string');
}

function readConfig(fileName: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, fileName), 'utf8')) as Record<string, unknown>;
}
