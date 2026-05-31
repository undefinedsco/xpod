import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { oidcTokenEndpoint } from './oidc-issuer';
import type { AuthMode } from '../authorization/AuthMode';
import { applyAuthModeEnv, isAuthModeEnvKey, resolveAuthModeInput } from '../authorization/AuthMode';
import { cssAuthModeConfigImports } from './bootstrap';

const CSS_COMPONENTS_CONTEXT = 'https://linkedsoftwaredependencies.org/bundles/npm/@solid/community-server/^8.0.0/components/context.jsonld';
const XPOD_COMPONENTS_CONTEXT = 'https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/xpod/^0.0.0/components/context.jsonld';
const ASYNC_HANDLERS_CONTEXT = 'https://linkedsoftwaredependencies.org/bundles/npm/asynchronous-handlers/^1.0.0/components/context.jsonld';

/**
 * Build the environment for the CSS child process.
 *
 * `oidcIssuer` is an xpod shorthand value, not a CSS CLI argument.
 * The legacy CSS child process path injects it through a generated
 * Components.js config instead of CSS_* env aliases.
 */
export function buildCssChildEnv(
  baseUrl: string,
  cssPort: number,
  oidcIssuer?: string,
  authModeInput?: AuthMode | string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const authMode = resolveAuthModeInput(authModeInput, baseEnv);
  const env: Record<string, string> = {
    ...baseEnv,
    CSS_PORT: cssPort.toString(),
    CSS_BASE_URL: baseUrl,
  } as Record<string, string>;
  applyAuthModeEnv(env, authMode);

  for (const key of Object.keys(env)) {
    if (key === 'oidcIssuer' || (isExternalOidcPollutionKey(key) && !isAuthModeEnvKey(key))) {
      delete env[key];
    }
  }

  return env;
}

function isExternalOidcPollutionKey(key: string): boolean {
  const normalized = key.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return normalized.includes('OIDCISSUER') ||
    normalized.includes('IDPURL') ||
    normalized.includes('IDPJWKSURL') ||
    normalized.includes('IDENTITYPROVIDERURL') ||
    normalized.includes('IDENTITYPROVIDERJWKSURL');
}

function toImportSpecifier(fromFilePath: string, toFilePath: string): string {
  if (pathNeedsEscapedFileUrl(fromFilePath) || pathNeedsEscapedFileUrl(toFilePath)) {
    return pathToFileURL(toFilePath).href;
  }

  const fromDirectory = path.dirname(fromFilePath);
  const relativePath = path.relative(fromDirectory, toFilePath).replace(/\\/g, '/');
  if (relativePath.startsWith('./') || relativePath.startsWith('../')) {
    return relativePath;
  }
  return `./${relativePath}`;
}

function pathNeedsEscapedFileUrl(filePath: string): boolean {
  return /\s/.test(filePath);
}

export function createCssChildRuntimeConfig(options: {
  configPath: string
  runtimeRoot: string
  authMode?: AuthMode | string
  externalOidcIssuer?: string
  baseEnv?: NodeJS.ProcessEnv
}): { configPath: string; cwd?: string } {
  fs.mkdirSync(options.runtimeRoot, { recursive: true });
  const runtimeConfigPath = path.join(options.runtimeRoot, 'css-child-runtime.config.json');
  const configImportPath = rewriteConfigForFileUrlImportsIfNeeded(
    path.resolve(options.configPath),
    path.join(options.runtimeRoot, 'config'),
  );
  const authMode = resolveAuthModeInput(options.authMode, options.baseEnv);
  fs.writeFileSync(runtimeConfigPath, JSON.stringify({
    '@context': [
      CSS_COMPONENTS_CONTEXT,
      XPOD_COMPONENTS_CONTEXT,
      ASYNC_HANDLERS_CONTEXT,
    ],
    import: [
      toImportSpecifier(runtimeConfigPath, configImportPath),
      ...cssAuthModeConfigImports(authMode),
    ],
    '@graph': [],
  }, null, 2), 'utf-8');

  if (options.externalOidcIssuer) {
    fs.writeFileSync(path.join(options.runtimeRoot, 'package.json'), JSON.stringify({
      private: true,
      name: 'xpod-css-runtime',
    }, null, 2), 'utf-8');
    fs.writeFileSync(path.join(options.runtimeRoot, '.community-solid-server.config.json'), JSON.stringify({
      oidcIssuer: options.externalOidcIssuer,
    }, null, 2), 'utf-8');
  }

  return {
    configPath: runtimeConfigPath,
    cwd: options.externalOidcIssuer ? options.runtimeRoot : undefined,
  };
}

function rewriteConfigForFileUrlImportsIfNeeded(
  configPath: string,
  outputDir: string,
  rewritten = new Map<string, string>(),
): string {
  if (!pathNeedsEscapedFileUrl(configPath)) {
    return configPath;
  }

  const existing = rewritten.get(configPath);
  if (existing) {
    return existing;
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, path.basename(configPath));
  rewritten.set(configPath, outputPath);

  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  parsed.import = rewriteConfigImports(configPath, parsed.import, outputDir, rewritten);
  fs.writeFileSync(outputPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');

  return outputPath;
}

function rewriteConfigImports(
  sourceConfigPath: string,
  imports: unknown,
  outputDir: string,
  rewritten: Map<string, string>,
): unknown {
  if (typeof imports === 'string') {
    return rewriteConfigImport(sourceConfigPath, imports, outputDir, rewritten);
  }

  if (Array.isArray(imports)) {
    return imports.map((value) => typeof value === 'string'
      ? rewriteConfigImport(sourceConfigPath, value, outputDir, rewritten)
      : value);
  }

  return imports;
}

function rewriteConfigImport(
  sourceConfigPath: string,
  importValue: string,
  outputDir: string,
  rewritten: Map<string, string>,
): string {
  if (!importValue.startsWith('./') && !importValue.startsWith('../')) {
    return importValue;
  }

  const targetPath = path.resolve(path.dirname(sourceConfigPath), importValue);
  const rewrittenTargetPath = rewriteConfigForFileUrlImportsIfNeeded(targetPath, outputDir, rewritten);
  return pathToFileURL(rewrittenTargetPath).href;
}

export function buildCssArgs(options: {
  cssBinary: string
  configPath: string
  cssModuleRoot: string
  cssPort: number
  baseUrl: string
  externalOidcIssuer?: string
}): string[] {
  return [
    options.cssBinary,
    '-c', options.configPath,
    '-m', options.cssModuleRoot,
    '-p', options.cssPort.toString(),
    '-b', options.baseUrl,
  ];
}

export function buildApiChildEnv(options: {
  apiPort: number
  mainPort: number
  cssPort: number
  baseUrl: string
  rdfIndexPath?: string
  authMode?: AuthMode | string
  externalOidcIssuer?: string
  baseEnv?: NodeJS.ProcessEnv
}): Record<string, string> {
  const authMode = resolveAuthModeInput(options.authMode, options.baseEnv);
  const env = {
    ...(options.baseEnv ?? process.env),
    ...(options.externalOidcIssuer ? { oidcIssuer: options.externalOidcIssuer } : {}),
    API_PORT: options.apiPort.toString(),
    XPOD_MAIN_PORT: options.mainPort.toString(),
    CSS_INTERNAL_URL: `http://localhost:${options.cssPort}`,
    CSS_BASE_URL: options.baseUrl,
    ...(options.rdfIndexPath ? { CSS_RDF_INDEX_PATH: options.rdfIndexPath } : {}),
    CSS_TOKEN_ENDPOINT: options.externalOidcIssuer
      ? oidcTokenEndpoint(options.externalOidcIssuer)
      : `${options.baseUrl}.oidc/token`,
  } as Record<string, string>;

  return applyAuthModeEnv(env, authMode);
}
