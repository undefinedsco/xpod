import path from 'node:path';
import { homedir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import type { CommandModule } from 'yargs';
import { ModuleStore } from '../module-store';
import { DEFAULT_SERVICE_MODULES } from '../module-catalog';
import { runForegroundModuleRuntime } from './module-runtime';
import { nodeRuntimeHost } from '../../../../src/runtime/host/node/NodeRuntimeHost';
import { buildApiChildEnv, buildCssChildEnv, buildCssArgs, createCssChildRuntimeConfig } from '../../../../src/runtime/css-process';
import type { RuntimeModuleDescription } from '../../../../src/runtime/service-plan';
import { resolveRuntimeDatabasePaths } from '../../../../src/runtime/database-url';
import { createGatewayAdminProxyAuthSecret } from '../../../../src/runtime/GatewayAdminProxyAuth';
import { autoProvisionFirstRunLocal } from '../../../../src/provision/first-run-registration';
import type { FirstRunProvisionConfig } from '../../../../src/provision/first-run-registration';
import { loadRuntimeIdentity, provisionedRuntimeEnv } from '../../../../src/provision/local-identity';
import { resolveCliOidcIssuer, resolveExternalOidcIssuer } from '../../../../src/runtime/oidc-issuer';
import { getLoggerFor } from 'global-logger-factory';

export interface StartBootstrapInput {
  ids: readonly string[];
  mode: 'local' | 'cloud';
  host: string;
  port: number;
  configuredBaseUrl?: string;
  /** Already resolved absolute data root. */
  data: string;
  oidcIssuer?: string;
}

export interface StartChildIdentity {
  nodeId?: string;
  nodeToken?: string;
  serviceToken?: string;
  provisionCode?: string;
  publicUrl?: string;
  spDomain?: string;
  localSetupPath: string;
  localSetupProviderId: string;
}

export interface StartBootstrap {
  apiOnly: boolean;
  baseUrl: string;
  externalOidcIssuer?: string;
  childIdentity: StartChildIdentity;
}

/**
 * Establish this runtime's identity authority BEFORE any child is created.
 *
 * A managed Local runtime is reachable on loopback, but its STORED resources live
 * at the Cloud-issued public origin. CSS derives every resource identifier from
 * the base URL (SingleRootIdentifierStrategy), so the base must be the canonical
 * authority persisted at provisioning time -- exactly what the legacy CLI and
 * XpodRuntime resolve before starting children. Falling back to loopback makes CSS
 * reject every canonical request as outside its configured identifier space.
 *
 * The identity inputs are the SAME ones the API child loads (device id under the
 * data root, provider-scoped setup record, credential precedence), so the
 * launcher cannot start CSS with a different node identity than the API child it
 * is about to create.
 */
export async function bootstrapStartRuntime(
  input: StartBootstrapInput,
  env: NodeJS.ProcessEnv,
  provision: typeof autoProvisionFirstRunLocal = autoProvisionFirstRunLocal,
): Promise<StartBootstrap> {
  const mode = input.mode;
  const port = input.port;
  const data = input.data;
  const configuredBaseUrl = input.configuredBaseUrl?.trim() || undefined;
  const identity = loadRuntimeIdentity(env, mode, data);
  // An API-only host owns no CSS identifier space, so it keeps the explicit base
  // URL exactly as before and never bootstraps a Local node identity.
  const apiOnly = input.ids.includes('api') && !input.ids.includes('css');
  const configuredAuthority = configuredBaseUrl ?? `http://localhost:${port}/`;
  // Canonical managed authority adoption is LOCAL-only. A Cloud runtime owns the
  // authority it was configured with; a Cloud env publicUrl must never override
  // it (HEAD honoured the explicit --baseUrl, and XpodRuntime only adopts a
  // provisioned canonical origin on the Local external-issuer path).
  const adoptProvisionedAuthority = !apiOnly && mode === 'local';
  let canonicalPublicUrl = adoptProvisionedAuthority ? identity.publicUrl : undefined;
  // Only an explicitly configured issuer (or one this device already registered
  // with) makes this a Cloud-managed runtime. An unconfigured modular start stays
  // standalone and must not contact Cloud: the desktop writes SOLID_OIDC_ISSUER
  // into its owned .env, and `bun run local` does the same through .env.local.
  // `--oidcIssuer` is the CLI spelling of the same explicit configuration; it is
  // merged into the resolved environment once so resolution still goes through the
  // single `SOLID_OIDC_ISSUER` contract (no second alias map).
  const issuerEnv = input.oidcIssuer?.trim()
    ? { ...env, SOLID_OIDC_ISSUER: input.oidcIssuer.trim() }
    : env;
  const managedIssuer = resolveCliOidcIssuer(
    issuerEnv,
    identity.localSetupState?.cloudIdentityUrl,
    undefined,
  );

  // First-run registration (or credential refresh) must finish BEFORE CSS reads
  // the base URL. This is the existing shared implementation the legacy CLI and
  // XpodRuntime use; the modular launcher previously skipped it entirely.
  const provisioned = apiOnly ? undefined : await provision({
    edition: mode,
    host: input.host,
    port,
    baseUrl: configuredAuthority,
    solidBaseUrl: configuredAuthority,
    rootDir: data,
    nodeId: identity.nodeId,
    nodeToken: identity.nodeToken,
    serviceToken: identity.serviceToken,
    provisionCode: identity.provisionCode,
    publicUrl: identity.publicUrl,
    spDomain: identity.spDomain,
    cloudApiEndpoint: env.XPOD_CLOUD_API_ENDPOINT?.trim() || undefined,
    localSetupPath: identity.localSetupPath,
    localSetupProviderId: identity.localSetupProviderId,
    // The launched desktop supplies the managed issuer through the same
    // SOLID_OIDC_ISSUER environment the legacy bootstrap already reads; the
    // remembered-issuer/loopback rules live in the shared resolver, never in a
    // second alias map here.
    oidcIssuer: managedIssuer,
  } satisfies FirstRunProvisionConfig, getLoggerFor('XpodCliStart'));
  canonicalPublicUrl = adoptProvisionedAuthority
    ? (provisioned?.publicUrl?.trim() || canonicalPublicUrl)
    : undefined;

  const baseUrl = String(canonicalPublicUrl || configuredAuthority);
  // Explicit configuration is the API-only authority (an implicit Local default
  // is not: it would let an API-only host pretend to own an IdP).
  const explicitOidcIssuer = resolveExternalOidcIssuer(issuerEnv);
  if (apiOnly) {
    let issuer: URL;
    try {
      issuer = new URL(explicitOidcIssuer ?? '');
    } catch {
      throw new Error('API-only runtime requires an independent OIDC issuer');
    }
    if (!['http:', 'https:'].includes(issuer.protocol) || issuer.origin === new URL(baseUrl).origin
      || issuer.username || issuer.password || issuer.search || issuer.hash) throw new Error('API-only runtime requires an independent OIDC issuer');
  }
  // The CSS child reads its IdP through the installed runtime config, and the API
  // child through the shorthand. Both receive the SAME authority bootstrap used;
  // a standalone runtime keeps no external issuer at all.
  const externalOidcIssuer = apiOnly
    ? explicitOidcIssuer
    : resolveCliOidcIssuer(issuerEnv, provisioned?.oidcIssuer, undefined);

  return {
    apiOnly,
    baseUrl,
    externalOidcIssuer,
    childIdentity: {
      nodeId: provisioned?.nodeId ?? identity.nodeId,
      nodeToken: provisioned?.nodeToken ?? identity.nodeToken,
      serviceToken: provisioned?.serviceToken ?? identity.serviceToken,
      provisionCode: provisioned?.provisionCode ?? identity.provisionCode,
      publicUrl: provisioned?.publicUrl ?? identity.publicUrl,
      spDomain: provisioned?.spDomain ?? identity.spDomain,
      localSetupPath: provisioned?.localSetupPath ?? identity.localSetupPath,
      localSetupProviderId: provisioned?.localSetupProviderId ?? identity.localSetupProviderId,
    },
  };
}

export function startCommand(store: ModuleStore): CommandModule {
  return {
    command: 'start', describe: 'Start installed CSS/API capabilities through the Xpod Gateway',
    builder: parser => parser
      .option('modules', { type: 'string', array: true, choices: ['css', 'api'], default: [...DEFAULT_SERVICE_MODULES] })
      .option('port', { type: 'number', default: 3000 })
      .option('baseUrl', { type: 'string' })
      .option('host', { type: 'string', default: '127.0.0.1' })
      .option('mode', { type: 'string', choices: ['local', 'cloud'], default: 'local' })
      .option('data', { type: 'string', default: path.join(homedir(), '.xpod', 'data') })
      .option('oidcIssuer', { type: 'string' }),
    handler: async argv => {
      const mode = argv.mode as 'local' | 'cloud';
      const ids = argv.modules as string[];
      const port = Number(argv.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535 || !ids.length) throw new Error('Select capabilities and a valid Gateway port.');
      const data = path.resolve(String(argv.data));
      await mkdir(data, { recursive: true });
      const bootstrap = await bootstrapStartRuntime({
        ids,
        mode,
        host: String(argv.host),
        port,
        configuredBaseUrl: typeof argv.baseUrl === 'string' ? argv.baseUrl : undefined,
        data,
        oidcIssuer: argv.oidcIssuer as string | undefined,
      }, process.env);
      const baseUrl = bootstrap.baseUrl;
      const externalOidcIssuer = bootstrap.externalOidcIssuer;
      // Thread the SAME identity bootstrap used. Explicit childEnv entries keep the
      // standalone CLI side-effect free while children observe one origin.
      const provisioned = bootstrap.childIdentity;
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
          const childEnv = { ...process.env, XPOD_EDITION: mode, CSS_ROOT_FILE_PATH: data,
            ...provisionedRuntimeEnv({ ...provisioned, oidcIssuer: externalOidcIssuer }),
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
          ingressPort: ports.ingress, externalOidcIssuer });
      });
    },
  };
}
