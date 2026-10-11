import path from 'node:path';
import { homedir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import type { CommandModule } from 'yargs';
import { ModuleStore } from '../module-store';
import { runForegroundModuleRuntime } from './module-runtime';
import { nodeRuntimeHost } from '../../../../src/runtime/host/node/NodeRuntimeHost';
import { buildApiChildEnv, buildCssChildEnv, buildCssArgs, createCssChildRuntimeConfig } from '../../../../src/runtime/css-process';
import type { RuntimeModuleDescription } from '../../../../src/runtime/service-plan';
import { resolveRuntimeDatabasePaths } from '../../../../src/runtime/database-url';
import { createGatewayAdminProxyAuthSecret } from '../../../../src/runtime/GatewayAdminProxyAuth';

export function startCommand(store: ModuleStore): CommandModule {
  return {
    command: 'start', describe: 'Start installed CSS/API capabilities through the Xpod Gateway',
    builder: parser => parser
      .option('modules', { type: 'string', array: true, choices: ['css', 'api'], default: ['css', 'api'] })
      .option('port', { type: 'number', default: 3000 })
      .option('baseUrl', { type: 'string' })
      .option('host', { type: 'string', default: '127.0.0.1' })
      .option('mode', { type: 'string', choices: ['local', 'cloud'], default: 'local' })
      .option('data', { type: 'string', default: path.join(homedir(), '.xpod', 'data') })
      .option('oidcIssuer', { type: 'string' }),
    handler: async argv => {
      const ids = argv.modules as string[];
      const port = Number(argv.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535 || !ids.length) throw new Error('Select capabilities and a valid Gateway port.');
      const baseUrl = String(argv.baseUrl ?? `http://localhost:${port}/`);
      // Validate the API-only authority before any installation or process startup.
      if (ids.includes('api') && !ids.includes('css')) {
        const issuer = new URL(String(argv.oidcIssuer ?? ''));
        if (!['http:', 'https:'].includes(issuer.protocol) || issuer.origin === new URL(baseUrl).origin
          || issuer.username || issuer.password || issuer.search || issuer.hash) throw new Error('API-only runtime requires an independent OIDC issuer');
      }
      const data = path.resolve(String(argv.data));
      await mkdir(data, { recursive: true });
      const databases = resolveRuntimeDatabasePaths({ runtimeRoot: data,
        identityDbUrl: process.env.CSS_IDENTITY_DB_URL ?? process.env.DATABASE_URL,
        usageDbUrl: process.env.CSS_USAGE_DB_URL,
        sparqlEndpoint: process.env.CSS_SPARQL_ENDPOINT ?? process.env.SPARQL_ENDPOINT,
        rdfIndexPath: process.env.CSS_RDF_INDEX_PATH,
      });
      const gatewayAdminProxyAuthSecret = createGatewayAdminProxyAuthSecret();
      const ports = await nodeRuntimeHost.allocatePorts({ gatewayPort: port });
      await store.withAdmittedModules(ids, async admitted => {
        const modules: RuntimeModuleDescription[] = admitted.map(module => {
          if (module.installed.id !== 'css' && module.installed.id !== 'api') throw new Error('Unsupported service capability');
          const id = module.installed.id;
          const mode = argv.mode as 'local' | 'cloud';
          const externalOidcIssuer = argv.oidcIssuer as string | undefined;
          const childEnv = { ...process.env, XPOD_EDITION: mode, CSS_ROOT_FILE_PATH: data,
            CSS_IDENTITY_DB_URL: databases.identityDbUrl, CSS_USAGE_DB_URL: databases.usageDbUrl,
            CSS_SPARQL_ENDPOINT: databases.sparqlEndpoint, CSS_RDF_INDEX_PATH: databases.rdfIndexPath,
          };
          const css = id === 'css' ? createCssChildRuntimeConfig({
            configPath: path.join(module.cwd, 'config', `${mode}.json`),
            runtimeRoot: path.join(data, '.runtime'), externalOidcIssuer, baseEnv: childEnv,
          }) : undefined;
          return { id, target: { url: `http://localhost:${ports[id]}` }, process: {
            name: id, command: process.execPath, cwd: css?.cwd ?? data,
            args: id === 'css' ? buildCssArgs({ cssBinary: module.entry, configPath: css!.configPath,
              cssModuleRoot: module.cwd, cssPort: ports.css, baseUrl }) : [module.entry],
            env: id === 'css' ? buildCssChildEnv(baseUrl, ports.css, externalOidcIssuer, undefined, childEnv, gatewayAdminProxyAuthSecret, mode)
              : buildApiChildEnv({ apiPort: ports.api, mainPort: port, cssPort: ports.css,
                ingressPort: ports.ingress, baseUrl, externalOidcIssuer, baseEnv: childEnv, gatewayAdminProxyAuthSecret }),
          } };
        });
        await runForegroundModuleRuntime({ modules, baseUrl, port, bindHost: String(argv.host),
          internalAdminAuthSecret: gatewayAdminProxyAuthSecret,
          ingressPort: ports.ingress, externalOidcIssuer: argv.oidcIssuer as string | undefined });
      });
    },
  };
}
