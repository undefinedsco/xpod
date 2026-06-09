/**
 * ProvisionPodCreator
 *
 * 等位替换 CSS 的 BasePodCreator。
 *
 * 检查 settings 里有没有 provisionCode：
 * - 有 → 解码 JWT，回调远端 SP 的 /provision/pods 创建 Pod
 * - 没有 → 委托给原始 BasePodCreator（标准本地创建）
 */

import { getLoggerFor } from 'global-logger-factory';
import {
  BasePodCreator,
  type PodCreatorInput,
  type PodCreatorOutput,
  type BasePodCreatorArgs,
  type ResourceIdentifier,
  type PodSettings,
  ConflictHttpError,
} from '@solid/community-server';
import { ProvisionCodeCodec } from './ProvisionCodeCodec';

function joinUrlPath(baseUrl: string, relativePath: string): string {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/u, '');
  const normalizedRelativePath = relativePath.replace(/^\/+/u, '');
  return `${normalizedBaseUrl}/${normalizedRelativePath}`;
}

function normalizeOptionalUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeUrlRoot(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }

  try {
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.replace(/\/+$/u, '') || '/';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function isSameUrlRoot(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeUrlRoot(left);
  const normalizedRight = normalizeUrlRoot(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function isSameNodeId(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.trim() === right.trim());
}

function buildDefaultWebId(issuer: string, podName: string, relativeWebIdPath: string): string {
  const normalizedRelativePath = relativeWebIdPath.replace(/^\/+/u, '');
  return joinUrlPath(issuer, `${encodeURIComponent(podName)}/${normalizedRelativePath}`);
}

function buildStorageRoot(payload: { spDomain?: string; spUrl: string }): string {
  return payload.spDomain ? `https://${payload.spDomain}` : payload.spUrl;
}

function buildPodUrl(storageRoot: string, podName: string): string {
  return joinUrlPath(storageRoot, `${encodeURIComponent(podName)}/`);
}

function stripProvisionCode(settings: PodCreatorInput['settings']): Record<string, unknown> | undefined {
  if (!settings) {
    return undefined;
  }

  const { provisionCode: _provisionCode, ...rest } = settings as Record<string, unknown>;
  return rest;
}

async function readProvisionResponseMessage(response: Response): Promise<string | undefined> {
  const text = await response.text().catch(() => '');
  if (!text) {
    return undefined;
  }

  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown };
    return typeof body.message === 'string'
      ? body.message
      : typeof body.error === 'string'
        ? body.error
        : text;
  } catch {
    return text;
  }
}

export interface ProvisionPodCreatorArgs extends BasePodCreatorArgs {
  /** 与 ProvisionHandler 使用相同的 baseUrl 派生签名密钥 */
  provisionBaseUrl?: string;
  /** Current SP node id; used to recognize this SP even when URLs differ by localhost/managed domain. */
  nodeId?: string;
  /** Kept in the component signature for config compatibility; Pod storage facts live in CSS account data. */
  identityDbUrl?: string;
}

interface StandardPodCreateOptions {
  baseIdentifier?: ResourceIdentifier;
  linkWebId?: boolean;
  oidcIssuer?: string;
  storageUrl?: string;
  webId?: string;
}

interface PreparedWebIdLink {
  /** Link id to expose in the create-pod response. May be an existing link. */
  outputWebIdLink?: string;
  /** Link id CSS may delete if Pod creation fails. Only newly-created links are safe here. */
  cleanupWebIdLink?: string;
}

function remapPodConflict(error: unknown, podName: string): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/There already is a resource at/i.test(message)) {
    throw new ConflictHttpError(`Pod name "${podName}" is already taken for this storage target.`, {
      cause: error instanceof Error ? error : undefined,
    });
  }

  throw error;
}

export class ProvisionPodCreator extends BasePodCreator {
  private readonly provisionLogger = getLoggerFor(this);
  private readonly codec: ProvisionCodeCodec;
  private readonly oidcIssuer?: string;
  private readonly currentNodeId?: string;

  public constructor(args: ProvisionPodCreatorArgs) {
    super(args);
    this.oidcIssuer = normalizeOptionalUrl(args.provisionBaseUrl);
    this.currentNodeId = normalizeOptionalString(args.nodeId);
    this.codec = new ProvisionCodeCodec(this.oidcIssuer ?? args.baseUrl);
  }

  public override async handle(input: PodCreatorInput): Promise<PodCreatorOutput> {
    const provisionCode = input.settings?.provisionCode as string | undefined;

    if (!provisionCode) {
      return this.handleStandardPodCreate(input);
    }

    // SP 模式：解码 provisionCode，回调远端 SP
    const payload = this.codec.decode(provisionCode);
    if (!payload) {
      throw new Error('Invalid or expired provisionCode');
    }

    // 1. 确定 podName
    const podName = input.name;
    if (!podName) {
      throw new Error('Pod name is required for remote provisioning');
    }
    const webId = input.webId ?? buildDefaultWebId(this.oidcIssuer ?? this.baseUrl, podName, this.relativeWebIdPath);
    const targetStorageRoot = buildStorageRoot(payload);
    const canonicalStorageUrl = buildPodUrl(targetStorageRoot, podName);
    const tokenOidcIssuer = normalizeUrlRoot(this.oidcIssuer ?? this.baseUrl) ?? this.oidcIssuer ?? this.baseUrl;

    if (this.targetsCurrentStorageProvider(payload, targetStorageRoot)) {
      this.provisionLogger.info(
        `Provision code targets current SP ${this.baseUrl}${this.currentNodeId ? ` (${this.currentNodeId})` : ''}; creating Pod directly through CSS`,
      );
      return this.handleStandardPodCreate(input, {
        baseIdentifier: { path: canonicalStorageUrl },
        linkWebId: !input.webId,
        oidcIssuer: tokenOidcIssuer,
        storageUrl: canonicalStorageUrl,
        webId,
      });
    }

    this.provisionLogger.info(`Provisioning pod on remote SP: ${payload.spUrl}`);

    // 2. 回调 SP 创建 Pod
    const callbackUrl = `${payload.spUrl.replace(/\/$/, '')}/provision/pods`;
    const spResponse = await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${payload.serviceToken}`,
      },
      body: JSON.stringify({ podName, webId }),
    });

    if (!spResponse.ok) {
      const message = await readProvisionResponseMessage(spResponse);
      this.provisionLogger.error(`SP callback failed: ${spResponse.status} ${message ?? ''}`);
      if (spResponse.status === 409 || /already exists|already taken|conflict/iu.test(message ?? '')) {
        throw new ConflictHttpError(message || `Pod name "${podName}" is already taken for this storage target.`);
      }
      throw new Error(message
        ? `Failed to create pod on SP: ${spResponse.status}: ${message}`
        : `Failed to create pod on SP: ${spResponse.status}`);
    }

    const spResult = await spResponse.json() as { podUrl?: string };

    // storage URL 优先用 Cloud 分配的子域名，回调用实际地址
    const podUrl = spResult.podUrl || canonicalStorageUrl;

    // 3. 链接 WebID 到账户 + 在本地 PodStore 记录
    // base.path 必须在 Cloud 的 identifier space 内（CSS PodStore 会检查），
    // 所以用 Cloud 本地路径；真实的 SP storage URL 通过 podUrl 返回。
    const localBase = this.identifierGenerator.generate(podName);
    const inputSettings = stripProvisionCode(input.settings);
    const podSettings = {
      ...inputSettings,
      base: localBase,
      webId,
      oidcIssuer: tokenOidcIssuer,
      storage: canonicalStorageUrl,
    };

    const webIdLink = await this.prepareWebIdLink(!input.webId, webId, input.accountId, podSettings);
    podSettings.oidcIssuer = tokenOidcIssuer;
    const podId = await this.createPod(input.accountId, podSettings, !input.name, webIdLink.cleanupWebIdLink);

    this.provisionLogger.info(`Provisioned pod ${podName} on SP ${payload.spUrl}, podUrl: ${podUrl}`);

    return {
      podUrl,
      webId,
      podId,
      webIdLink: webIdLink.outputWebIdLink,
    };
  }

  private targetsCurrentStorageProvider(payload: { nodeId?: string; spUrl: string }, targetStorageRoot: string): boolean {
    return isSameNodeId(payload.nodeId, this.currentNodeId) ||
      isSameUrlRoot(payload.spUrl, this.baseUrl) ||
      isSameUrlRoot(targetStorageRoot, this.baseUrl);
  }

  private async handleStandardPodCreate(
    input: PodCreatorInput,
    options: StandardPodCreateOptions = {},
  ): Promise<PodCreatorOutput> {
    const totalStarted = Date.now();
    const baseIdentifier = options.baseIdentifier ?? this.generateBaseIdentifier(input.name);
    const inputSettings = stripProvisionCode(input.settings);
    const oidcIssuer = options.oidcIssuer ?? (typeof inputSettings?.oidcIssuer === 'string'
      ? inputSettings.oidcIssuer
      : this.oidcIssuer ?? this.baseUrl);
    const webId = options.webId ?? input.webId ?? (input.name
      ? buildDefaultWebId(oidcIssuer, input.name, this.relativeWebIdPath)
      : joinUrlPath(baseIdentifier.path, this.relativeWebIdPath));
    const storageUrl = options.storageUrl ?? baseIdentifier.path;
    const podSettings = {
      ...inputSettings,
      base: baseIdentifier,
      webId,
      oidcIssuer,
      storage: storageUrl,
    };
    const linkWebId = options.linkWebId ?? !input.webId;

    const webIdStarted = Date.now();
    const webIdLink = await this.prepareWebIdLink(linkWebId, webId, input.accountId, podSettings);
    podSettings.oidcIssuer = oidcIssuer;
    const webIdElapsed = Date.now() - webIdStarted;

    const podStarted = Date.now();
    let podId: string;
    try {
      podId = await this.createPod(input.accountId, podSettings, !input.name, webIdLink.cleanupWebIdLink);
    } catch (error) {
      if (input.name) {
        remapPodConflict(error, input.name);
      }
      throw error;
    }
    const podElapsed = Date.now() - podStarted;
    const totalElapsed = Date.now() - totalStarted;

    this.provisionLogger.info(
      `[timing] ProvisionPodCreator.standard account=${input.accountId} pod=${baseIdentifier.path} handleWebId=${webIdElapsed}ms createPod=${podElapsed}ms total=${totalElapsed}ms`,
    );

    return {
      podUrl: baseIdentifier.path,
      webId,
      podId,
      webIdLink: webIdLink.outputWebIdLink,
    };
  }

  private async prepareWebIdLink(
    linkWebId: boolean,
    webId: string,
    accountId: string,
    settings: PodSettings,
  ): Promise<PreparedWebIdLink> {
    if (!linkWebId) {
      return {};
    }

    const existingLink = await this.findExistingWebIdLink(webId, accountId);
    if (existingLink) {
      this.provisionLogger.info(`Reusing existing WebID link ${existingLink.id} for ${webId}`);
      return { outputWebIdLink: existingLink.id };
    }

    const createdLink = await this.handleWebId(true, webId, accountId, settings);
    return {
      outputWebIdLink: createdLink,
      cleanupWebIdLink: createdLink,
    };
  }

  private async findExistingWebIdLink(
    webId: string,
    accountId: string,
  ): Promise<{ id: string; webId: string } | undefined> {
    const normalizedTarget = normalizeUrlRoot(webId) ?? webId;
    const links = await this.webIdStore.findLinks(accountId);
    return links.find((link) => (normalizeUrlRoot(link.webId) ?? link.webId) === normalizedTarget);
  }
}
