import { oidcTokenEndpoint } from './oidc-issuer';

/**
 * Build the environment for the CSS child process.
 *
 * The public process-level contract is CSS_OIDC_ISSUER. CSS itself only
 * receives the internal Components shorthand via --idpUrl; passing the env
 * through can make yargs derive an unsupported oidcIssuer argument.
 */
export function buildCssChildEnv(
  baseUrl: string,
  cssPort: number,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    ...baseEnv,
    CSS_PORT: cssPort.toString(),
    CSS_BASE_URL: baseUrl,
  } as Record<string, string>;

  delete env.CSS_OIDC_ISSUER;
  delete env.CSS_IDP_URL;
  delete env.XPOD_OIDC_ISSUER;
  delete env.oidcIssuer;
  delete env.idpUrl;

  return env;
}

export function buildCssArgs(options: {
  cssBinary: string
  configPath: string
  cssModuleRoot: string
  cssPort: number
  baseUrl: string
  externalOidcIssuer?: string
}): string[] {
  const args = [
    options.cssBinary,
    '-c', options.configPath,
    '-m', options.cssModuleRoot,
    '-p', options.cssPort.toString(),
    '-b', options.baseUrl,
  ];
  if (options.externalOidcIssuer) {
    args.push('--idpUrl', options.externalOidcIssuer);
  }
  return args;
}

export function buildApiChildEnv(options: {
  apiPort: number
  mainPort: number
  cssPort: number
  baseUrl: string
  externalOidcIssuer?: string
  baseEnv?: NodeJS.ProcessEnv
}): Record<string, string> {
  return {
    ...(options.baseEnv ?? process.env),
    API_PORT: options.apiPort.toString(),
    XPOD_MAIN_PORT: options.mainPort.toString(),
    CSS_INTERNAL_URL: `http://localhost:${options.cssPort}`,
    CSS_BASE_URL: options.baseUrl,
    CSS_TOKEN_ENDPOINT: options.externalOidcIssuer
      ? oidcTokenEndpoint(options.externalOidcIssuer)
      : `${options.baseUrl}.oidc/token`,
  } as Record<string, string>;
}
