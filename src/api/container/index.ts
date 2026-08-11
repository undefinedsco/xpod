/**
 * API Container 入口
 *
 * 使用 Awilix 进行依赖注入，根据 edition 注册不同服务
 */

import { createContainer, asValue, InjectionMode, type AwilixContainer } from 'awilix';
import { randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ApiContainerCradle, ApiContainerConfig } from './types';
import { registerCommonServices } from './common';
import { registerCloudServices } from './cloud';
import { registerLocalServices } from './local';
import { registerBusinessToken } from './business-token';
import { resolveExternalOidcIssuer } from '../../runtime/oidc-issuer';
import { resolveAuthModeFromEnv } from '../../authorization/AuthMode';
import { readLocalProvisionState, resolveLocalSetupPath, resolveLocalSetupProviderId } from '../../provision/LocalProvisionState';
import { resolveTunnelProfileState } from '../../tunnel/TunnelProfiles';
import {
  DeploymentRootKeyProvider,
  parseDeploymentRootKeyConfig,
  SecretCellVault,
} from '../../security/secret-cell';
import { SecretCellCredentialVault } from '../ai-gateway/credentials/SecretCellCredentialVault';
import type { CredentialVault } from '../ai-gateway/credentials/CredentialVault';

export type { ApiContainerCradle, ApiContainerConfig } from './types';

const OFFICIAL_CLOUD_IDENTITY_ORIGIN = 'https://id.undefineds.co';
const OFFICIAL_CLOUD_API_ORIGIN = 'https://api.undefineds.co';

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function resolveCssTokenEndpoint(): string {
  if (process.env.CSS_TOKEN_ENDPOINT) {
    return process.env.CSS_TOKEN_ENDPOINT;
  }

  if (process.env.CSS_BASE_URL) {
    return `${ensureTrailingSlash(process.env.CSS_BASE_URL)}.oidc/token`;
  }

  return 'http://localhost:3000/.oidc/token';
}

function normalizeOptionalBaseUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const url = new URL(value);
  return url.toString().replace(/\/$/u, '');
}

function resolveEdition(value: string | undefined): 'cloud' | 'local' {
  const edition = (value ?? 'local').replace(/\s+#.*$/u, '').trim();
  if (edition === 'cloud' || edition === 'local') {
    return edition;
  }
  throw new Error('XPOD_EDITION must be either "local" or "cloud"');
}

/**
 * 创建 API 容器
 */
export function createApiContainer(config: ApiContainerConfig): AwilixContainer<ApiContainerCradle> {
  const container = createContainer<ApiContainerCradle>({
    injectionMode: InjectionMode.PROXY,
    strict: true,
  });

  // 注册配置
  container.register({
    config: asValue(config),
    inngestRuntimeConfig: asValue(config.inngestRuntimeConfig),
  });

  // 注册共享服务
  registerCommonServices(container);

  // 根据 edition 注册专属服务
  if (config.edition === 'cloud') {
    registerCloudServices(container);
  } else {
    registerLocalServices(container);
  }

  // 注册 Business Token (如果配置了 XPOD_BUSINESS_TOKEN)
  registerBusinessToken(container);

  return container;
}

/**
 * 从环境变量读取配置
 */
export function loadConfigFromEnv(): ApiContainerConfig {
  const edition = resolveEdition(process.env.XPOD_EDITION);
  const rootDir = process.env.CSS_ROOT_FILE_PATH || './data';
  const localSetupPath = resolveLocalSetupPath(process.env.XPOD_LOCAL_SETUP_PATH, rootDir);
  const localSetupProviderId = resolveLocalSetupProviderId(process.env.XPOD_PROVIDER_ID);
  const localSetupState = edition === 'local'
    ? readLocalProvisionState(localSetupPath, localSetupProviderId)
    : undefined;

  // Port auto-increment: API_PORT = CSS_PORT + 1 if not explicitly set
  const cssPort = parseInt(process.env.CSS_PORT ?? '3000', 10);
  const apiPort = process.env.API_PORT
    ? parseInt(process.env.API_PORT, 10)
    : cssPort + 1;

  const cloudApiEndpoint = process.env.XPOD_CLOUD_API_ENDPOINT
    ?? localSetupState?.cloudApiUrl
    ?? OFFICIAL_CLOUD_API_ORIGIN;
  const nodeId = loadOrGenerateDeviceId(process.env.XPOD_NODE_ID ?? localSetupState?.nodeId);
  const nodeToken = process.env.XPOD_NODE_TOKEN ?? localSetupState?.nodeToken;
  const serviceToken = process.env.XPOD_SERVICE_TOKEN ?? localSetupState?.serviceToken;
  const oidcIssuer = resolveExternalOidcIssuer(process.env)
    ?? localSetupState?.cloudIdentityUrl
    ?? (
      nodeToken
        ? OFFICIAL_CLOUD_IDENTITY_ORIGIN
        : undefined
    );
  const tunnelProfileState = resolveTunnelProfileState(process.env);
  const secretCellCredentialVaultFactory = loadSecretCellCredentialVaultFactory(process.env);
  const openAiGatewayBaseUrl = normalizeOptionalBaseUrl(process.env.XPOD_AI_GATEWAY_OPENAI_BASE_URL);
  const aiClientConfiguration = edition === 'local'
    ? loadAiClientConfiguration(process.env)
    : undefined;

  return {
    edition,
    port: apiPort,
    host: process.env.API_HOST ?? '0.0.0.0',
    socketPath: process.env.API_SOCKET_PATH,
    authMode: resolveAuthModeFromEnv(process.env),
    rdfIndexPath: process.env.CSS_RDF_INDEX_PATH,
    databaseUrl: process.env.CSS_IDENTITY_DB_URL ?? process.env.DATABASE_URL ?? '',
    sparqlEndpoint: process.env.CSS_SPARQL_ENDPOINT ?? process.env.SPARQL_ENDPOINT,
    rdfNativeSparqlEnabled: process.env.XPOD_RDF_NATIVE_SPARQL_ENABLED === 'true',
    redisUrl: process.env.CSS_REDIS_CLIENT ?? process.env.REDIS_URL,
    corsOrigins: process.env.CORS_ORIGINS?.split(',').map(s => s.trim()) ?? ['*'],
    cssTokenEndpoint: resolveCssTokenEndpoint(),
    solidBaseUrl: process.env.CSS_BASE_URL,
    gatewayLocatorSecret: process.env.XPOD_GATEWAY_LOCATOR_SECRET,
    gatewayLocatorKeyId: process.env.XPOD_GATEWAY_LOCATOR_KEY_ID,
    gatewayPreviousLocatorSecrets: parseGatewayPreviousLocatorSecrets(process.env.XPOD_GATEWAY_PREVIOUS_LOCATOR_SECRETS),
    gatewayInternalClientId: process.env.XPOD_GATEWAY_INTERNAL_CLIENT_ID,
    gatewayInternalClientSecret: process.env.XPOD_GATEWAY_INTERNAL_CLIENT_SECRET,
    aiConnectionInvocationSecret: process.env.XPOD_AI_CONNECTION_INVOCATION_SECRET,
    aiConnectionInvocationKeyId: process.env.XPOD_AI_CONNECTION_INVOCATION_KEY_ID,
    aiConnectionPreviousInvocationSecrets: parsePreviousInvocationSecrets(process.env.XPOD_AI_CONNECTION_PREVIOUS_INVOCATION_SECRETS),
    aiGatewaySessionAffinitySecret: process.env.XPOD_AI_GATEWAY_SESSION_AFFINITY_SECRET,
    gatewayAdminProxyAuthSecret: process.env.XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET,
    // Connections are part of the product surface by default; operators can
    // explicitly disable the management flow for a locked-down deployment.
    aiGatewayConnectEnabled: process.env.XPOD_AI_GATEWAY_CONNECT_ENABLED === 'true',
    secretCellCredentialVaultFactory,
    aiGatewayConnectSigningSecret: process.env.XPOD_AI_GATEWAY_CONNECT_SIGNING_SECRET,
    aiGatewayKimiOAuthIntegrationId: process.env.XPOD_AI_GATEWAY_KIMI_OAUTH_INTEGRATION_ID,
    aiGatewayKimiOAuthClientId: process.env.XPOD_AI_GATEWAY_KIMI_OAUTH_CLIENT_ID,
    aiGatewayProviderBaseUrls: openAiGatewayBaseUrl ? { openai: openAiGatewayBaseUrl } : undefined,
    aiClientConfiguration,
    inngest: {
      enabled: process.env.XPOD_INNGEST_ENABLED !== 'false',
      mode: process.env.XPOD_INNGEST_MODE === 'spawn' || process.env.XPOD_INNGEST_MODE === 'managed'
        ? process.env.XPOD_INNGEST_MODE
        : undefined,
      port: process.env.XPOD_INNGEST_PORT ? parseInt(process.env.XPOD_INNGEST_PORT, 10) : undefined,
      host: process.env.XPOD_INNGEST_HOST ?? '127.0.0.1',
      baseUrl: process.env.XPOD_INNGEST_BASE_URL,
      eventKey: process.env.XPOD_INNGEST_EVENT_KEY ?? process.env.INNGEST_EVENT_KEY,
      signingKey: process.env.XPOD_INNGEST_SIGNING_KEY ?? process.env.INNGEST_SIGNING_KEY,
      binaryPath: process.env.XPOD_INNGEST_BIN,
      sqliteDir: process.env.XPOD_INNGEST_SQLITE_DIR,
    },

    // 子域名配置 (cloud 模式)
    subdomain: {
      baseStorageDomain: process.env.CSS_BASE_STORAGE_DOMAIN,
      cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN,
      tencentDnsSecretId: process.env.TENCENT_DNS_SECRET_ID,
      tencentDnsSecretKey: process.env.TENCENT_DNS_SECRET_KEY,
    },

    // Local 托管式：连接 Cloud
    cloudApiEndpoint,
    nodeId,
    nodeToken,
    serviceToken,
    provisionCode: process.env.XPOD_PROVISION_CODE ?? localSetupState?.provisionCode,
    publicUrl: process.env.XPOD_PUBLIC_URL ?? localSetupState?.publicUrl,
    spDomain: process.env.XPOD_SP_DOMAIN ?? localSetupState?.spDomain,
    localSetupPath,
    localSetupProviderId,

    // OIDC Issuer (Local 托管式使用 Cloud IdP)
    // 如果配置了 XPOD_NODE_TOKEN，默认使用 Cloud IdP
    oidcIssuer,

    // 隧道配置
    tunnelProvider: tunnelProfileState.activeProvider,
    tunnelProfiles: tunnelProfileState.profiles,
    tunnelActiveProfileId: tunnelProfileState.activeProfileId,
    activeTunnelProfile: tunnelProfileState.activeProfile,
    cloudflareTunnelToken: process.env.CLOUDFLARE_TUNNEL_TOKEN,
    // Prefer SAKURA_TUNNEL_TOKEN; keep SAKURA_TOKEN for backward compatibility.
    sakuraTunnelToken: process.env.SAKURA_TUNNEL_TOKEN ?? process.env.SAKURA_TOKEN,
    ngrokAuthToken: process.env.NGROK_AUTHTOKEN,
    ngrokUrl: process.env.NGROK_URL,
    ngrokPath: process.env.NGROK_BIN,

    // Edge 节点管理 (cloud 模式)
    edgeNodesEnabled: process.env.XPOD_EDGE_NODES_ENABLED === 'true',
  };
}

function loadAiClientConfiguration(env: NodeJS.ProcessEnv): ApiContainerConfig['aiClientConfiguration'] {
  if (env.XPOD_AI_CLIENT_CONFIGURATION_ENABLED !== 'true') {
    return undefined;
  }

  const homeDir = path.resolve(nonEmptyEnv(env.XPOD_AI_CLIENT_CONFIGURATION_HOME_DIR) ?? env.HOME ?? os.homedir());
  const backupRoot = nonEmptyEnv(env.XPOD_AI_CLIENT_CONFIGURATION_BACKUP_ROOT);
  return {
    enabled: true,
    authority: 'local-filesystem',
    homeDir,
    ...(backupRoot ? { backupRoot: path.resolve(backupRoot) } : {}),
  };
}

function nonEmptyEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function loadSecretCellCredentialVaultFactory(env: NodeJS.ProcessEnv): (() => CredentialVault) | undefined {
  const activeKeyId = env.XPOD_SECRET_CELL_KEY_ID?.trim();
  const activeKey = env.XPOD_SECRET_CELL_KEY;
  const previousKeysJson = env.XPOD_SECRET_CELL_PREVIOUS_KEYS;
  if (!activeKeyId && !activeKey && !previousKeysJson) {
    return undefined;
  }
  if (!activeKeyId || !activeKey) {
    throw new Error('XPOD_SECRET_CELL_KEY_ID and XPOD_SECRET_CELL_KEY must be configured together');
  }
  assertSecretCellKeyId(activeKeyId, 'XPOD_SECRET_CELL_KEY_ID');

  const keys = Object.create(null) as Record<string, Uint8Array>;
  keys[activeKeyId] = parseDeploymentRootKeyConfig(activeKey);
  if (previousKeysJson) {
    let previous: unknown;
    try {
      previous = JSON.parse(previousKeysJson);
    } catch {
      throw new Error('XPOD_SECRET_CELL_PREVIOUS_KEYS must be a JSON object of keyId to base64 key');
    }
    if (!previous || typeof previous !== 'object' || Array.isArray(previous)) {
      throw new Error('XPOD_SECRET_CELL_PREVIOUS_KEYS must be a JSON object of keyId to base64 key');
    }
    for (const [keyId, value] of Object.entries(previous as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        throw new Error('XPOD_SECRET_CELL_PREVIOUS_KEYS must map non-empty keyIds to base64 keys');
      }
      assertSecretCellKeyId(keyId, 'XPOD_SECRET_CELL_PREVIOUS_KEYS keyId');
      if (keyId === activeKeyId) {
        throw new Error('XPOD_SECRET_CELL_PREVIOUS_KEYS must not redefine the active keyId');
      }
      keys[keyId] = parseDeploymentRootKeyConfig(value);
    }
  }

  return () => new SecretCellCredentialVault({
    vault: new SecretCellVault({
      rootKeys: new DeploymentRootKeyProvider({ activeKeyId, keys }),
    }),
  });
}

function assertSecretCellKeyId(value: string, variable: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${variable} must be 1-128 safe key ID characters`);
  }
}

function parsePreviousInvocationSecrets(value: string | undefined): Array<{ kid: string; secret: string }> | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(':');
      if (separator <= 0 || separator === entry.length - 1) {
        throw new Error('XPOD_GATEWAY_PREVIOUS_LOCATOR_SECRETS entries must be kid:secret');
      }
      return {
        kid: entry.slice(0, separator),
        secret: entry.slice(separator + 1),
      };
    });
  return entries.length ? entries : undefined;
}

function parseGatewayPreviousLocatorSecrets(value: string | undefined): Array<{ kid: string; secret: string }> | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(':');
      if (separator <= 0 || separator === entry.length - 1) {
        throw new Error('XPOD_GATEWAY_PREVIOUS_LOCATOR_SECRETS entries must be kid:secret');
      }
      return {
        kid: entry.slice(0, separator),
        secret: entry.slice(separator + 1),
      };
    });
  return entries.length ? entries : undefined;
}

/**
 * 获取设备首个非内部网卡的 MAC 地址。
 * 返回小写冒号分隔格式，如 "aa:bb:cc:dd:ee:ff"。
 * 容器/虚拟机中可能拿不到稳定 MAC，此时返回 undefined。
 */
function getFirstMacAddress(): string | undefined {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        return iface.mac.toLowerCase();
      }
    }
  }
  return undefined;
}

/**
 * 读取或生成设备 ID（持久化到 data/.device-id）。
 *
 * 优先级：
 *   1. 环境变量 XPOD_NODE_ID
 *   2. 已持久化的 data/.device-id
 *   3. 基于 MAC 地址的 SHA-256 哈希（截取前 32 位 hex）
 *   4. 随机 UUID（容器/虚拟机无稳定 MAC 时兜底）
 *
 * 生成后写入 data/.device-id，后续启动直接读取，保证同一设备 ID 稳定。
 */
function loadOrGenerateDeviceId(envNodeId?: string): string | undefined {
  if (envNodeId) {
    return envNodeId;
  }

  const rootDir = process.env.CSS_ROOT_FILE_PATH || './data';
  const deviceIdPath = path.join(rootDir, '.device-id');

  // 尝试从文件读取
  try {
    if (fs.existsSync(deviceIdPath)) {
      const content = fs.readFileSync(deviceIdPath, 'utf-8').trim();
      if (content) {
        return content;
      }
    }
  } catch {
    // 读取失败，继续生成
  }

  // 优先用 MAC 哈希，拿不到则 UUID 兜底
  const mac = getFirstMacAddress();
  const deviceId = mac
    ? createHash('sha256').update(mac).digest('hex').slice(0, 32)
    : randomUUID();

  try {
    if (!fs.existsSync(rootDir)) {
      fs.mkdirSync(rootDir, { recursive: true });
    }
    fs.writeFileSync(deviceIdPath, deviceId, 'utf-8');
  } catch {
    // 写入失败不阻塞启动
  }

  return deviceId;
}
