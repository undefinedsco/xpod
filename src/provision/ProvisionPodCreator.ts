/**
 * ProvisionPodCreator
 *
 * 等位替换 CSS 的 BasePodCreator。
 *
 * 检查 settings 里有没有 provisionCode：
 * - 有 → 解码签名 provision code，核验锁外预创建的 Local Pod 回执，并写入 Account 绑定
 * - 没有 → 委托给原始 BasePodCreator（标准本地创建）
 */

import { getLoggerFor } from 'global-logger-factory';
import { Readable } from 'node:stream';
import { DataFactory, Parser, Writer } from 'n3';
import {
  BasePodCreator,
  BasicRepresentation,
  guardStream,
  readableToString,
  type PodCreatorInput,
  type PodCreatorOutput,
  type BasePodCreatorArgs,
  type ResourceIdentifier,
  type ResourceStore,
  type PodSettings,
  BadRequestHttpError,
  ConflictHttpError,
} from '@solid/community-server';
import { EdgeNodeRepository } from '../identity/drizzle/EdgeNodeRepository';
import { getIdentityDatabase } from '../identity/drizzle/db';
import { ProvisionCodeCodec } from './ProvisionCodeCodec';
import { verifyProvisionReceipt } from './ProvisionReceiptCodec';
import { XPOD_REMOTE_PROVISIONED } from './ProvisionPodStore';

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

function isSameUrlReference(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  try {
    return new URL(left).toString() === new URL(right).toString();
  } catch {
    return false;
  }
}

function buildStorageRoot(payload: { spDomain?: string; spUrl: string }): string {
  return payload.spDomain ? `https://${payload.spDomain}` : payload.spUrl;
}

function buildPodUrl(storageRoot: string, podName: string): string {
  return joinUrlPath(storageRoot, `${encodeURIComponent(podName)}/`);
}

function stripProvisionCredentials(settings: PodCreatorInput['settings']): Record<string, unknown> | undefined {
  if (!settings) {
    return undefined;
  }

  const {
    provisionCode: _provisionCode,
    provisionReceipt: _provisionReceipt,
    ...rest
  } = settings as Record<string, unknown>;
  return rest;
}

export interface ProvisionPodCreatorArgs extends BasePodCreatorArgs {
  /** 与 ProvisionHandler 使用相同的 baseUrl 派生签名密钥 */
  provisionBaseUrl?: string;
  /** Current SP node id; used to recognize this SP even when URLs differ by localhost/managed domain. */
  nodeId?: string;
  /** Kept in the component signature for config compatibility; Pod storage facts live in CSS account data. */
  identityDbUrl?: string;
  /**
   * Server-internal resource store. Used only to reconcile native same-server Pod profiles.
   * Managed Local profiles are created on the Local SP before the Cloud Account lock is entered.
   */
  resourceStore?: ResourceStore;
  edgeNodeRepository?: ProvisionReceiptNodeRepository;
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

interface ProvisionReceiptNodeRepository {
  getSpNode(nodeId: string): Promise<{ serviceTokenHash: string } | undefined>;
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
  private readonly resourceStore?: ResourceStore;
  private readonly edgeNodeRepository?: ProvisionReceiptNodeRepository;

  public constructor(args: ProvisionPodCreatorArgs) {
    super(args);
    this.oidcIssuer = normalizeOptionalUrl(args.provisionBaseUrl);
    this.currentNodeId = normalizeOptionalString(args.nodeId);
    this.resourceStore = args.resourceStore;
    this.edgeNodeRepository = args.edgeNodeRepository ?? (args.identityDbUrl
      ? new EdgeNodeRepository(getIdentityDatabase(args.identityDbUrl))
      : undefined);
    this.codec = new ProvisionCodeCodec(this.oidcIssuer ?? args.baseUrl);
  }

  public override async handle(input: PodCreatorInput): Promise<PodCreatorOutput> {
    const provisionCode = input.settings?.provisionCode as string | undefined;

    if (!provisionCode) {
      return this.handleStandardPodCreate(input);
    }

    // SP 模式：解码 provisionCode，并核验锁外预创建的 Local Pod 回执。
    const payload = this.codec.decode(provisionCode);
    if (!payload) {
      throw new Error('Invalid or expired provisionCode');
    }

    // 1. 确定 podName
    const podName = input.name;
    if (!podName) {
      throw new Error('Pod name is required for remote provisioning');
    }
    const targetStorageRoot = buildStorageRoot(payload);
    const canonicalStorageUrl = buildPodUrl(targetStorageRoot, podName);
    const canonicalWebId = joinUrlPath(canonicalStorageUrl, this.relativeWebIdPath);
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
        webId: input.webId ?? canonicalWebId,
      });
    }

    // CSS Account Pod 创建运行在 6 秒资源锁内。任何 Local/Cloud/P2P 网络请求
    // 都必须在进入此处理器前完成。锁内工作明确限定为：读取本地 SP
    // receipt secret、HMAC 核验，以及 CSS 原生 WebID-link/Pod account-store
    // 读写。这里不会读取或改写远端 WebID profile；它已由 Local SP 创建。
    const receiptSecret = await this.resolveRemoteReceiptSecret(payload.nodeId);
    if (!receiptSecret) {
      throw new BadRequestHttpError('Local Pod preparation could not be verified.');
    }
    const provisionReceipt = typeof input.settings?.provisionReceipt === 'string'
      ? input.settings.provisionReceipt
      : undefined;
    if (!provisionReceipt) {
      throw new BadRequestHttpError('Local Pod must be prepared before it can be linked.');
    }
    const receipt = verifyProvisionReceipt(provisionReceipt, { secret: receiptSecret });
    if (!receipt.valid) {
      throw new BadRequestHttpError('Local Pod preparation could not be verified.');
    }
    const webId = input.webId ?? receipt.payload.webId;
    if (
      receipt.payload.podName !== podName
      || !isSameUrlReference(receipt.payload.webId, canonicalWebId)
      || !isSameUrlReference(webId, canonicalWebId)
      || !isSameUrlRoot(receipt.payload.podUrl, canonicalStorageUrl)
    ) {
      throw new BadRequestHttpError('Local Pod preparation could not be verified.');
    }
    const podUrl = canonicalStorageUrl;

    // 3. Link the WebID and record the remote Pod in account storage.
    // ProvisionPodStore uses the marker below to persist settings.storage
    // instead of creating a phantom Cloud Pod at settings.base.path.
    const localBase = this.identifierGenerator.generate(podName);
    const inputSettings = stripProvisionCredentials(input.settings);
    const podSettings = {
      ...inputSettings,
      base: localBase,
      webId,
      oidcIssuer: tokenOidcIssuer,
      storage: canonicalStorageUrl,
      [XPOD_REMOTE_PROVISIONED]: true,
    };

    // The signed Local receipt makes this WebID an Xpod-managed identity, so it
    // is safe to link automatically even though its document lives on the Local SP.
    const webIdLink = await this.prepareWebIdLink(true, webId, input.accountId, podSettings);
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

  private async resolveRemoteReceiptSecret(nodeId: string | undefined): Promise<string | undefined> {
    if (!nodeId || !this.edgeNodeRepository) {
      return undefined;
    }

    const spNode = await this.edgeNodeRepository.getSpNode(nodeId);
    return spNode?.serviceTokenHash || undefined;
  }

  private async handleStandardPodCreate(
    input: PodCreatorInput,
    options: StandardPodCreateOptions = {},
  ): Promise<PodCreatorOutput> {
    const totalStarted = Date.now();
    const baseIdentifier = options.baseIdentifier ?? this.generateBaseIdentifier(input.name);
    const inputSettings = stripProvisionCredentials(input.settings);
    const oidcIssuer = options.oidcIssuer ?? (typeof inputSettings?.oidcIssuer === 'string'
      ? inputSettings.oidcIssuer
      : this.oidcIssuer ?? this.baseUrl);
    const webId = options.webId ?? input.webId ?? joinUrlPath(baseIdentifier.path, this.relativeWebIdPath);
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

    await this.syncProfileStorageBinding(webId, storageUrl);

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

  /**
   * Reconcile the solid:storage binding in a WebID profile card hosted on this server.
   * CSS remains the sole owner of the native Pod resources and their authorization; Xpod only
   * adds or updates this product-specific relation after CSS has finished creating the Pod.
   * Standard CSS creation keeps this best-effort. Managed Local-Pod profiles are
   * created and signed by the Local SP before the Cloud Account resource lock.
   */
  private async syncProfileStorageBinding(
    webId: string,
    storageUrl: string,
  ): Promise<void> {
    try {
      await this.writeProfileStorageBinding(webId, storageUrl);
    } catch (error: unknown) {
      this.provisionLogger.error(
        `Failed to sync solid:storage in profile card for ${webId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async writeProfileStorageBinding(webId: string, storageUrl: string): Promise<void> {
    if (!this.resourceStore) {
      return;
    }

    const cardUrl = webId.split('#')[0];
    if (!cardUrl || new URL(cardUrl).origin !== new URL(this.baseUrl).origin) {
      return;
    }

    const identifier = { path: cardUrl };
    const representation = await this.resourceStore.getRepresentation(identifier, {
      type: { 'text/turtle': 1 },
    });
    const turtle = await readableToString(representation.data);

    const webIdNode = DataFactory.namedNode(webId);
    const storagePredicate = DataFactory.namedNode('http://www.w3.org/ns/solid/terms#storage');
    const quads = new Parser().parse(turtle);
    const storageQuads = quads.filter((quad) =>
      quad.subject.equals(webIdNode) && quad.predicate.equals(storagePredicate));

    if (storageQuads.length === 1 && storageQuads[0].object.value === storageUrl) {
      return;
    }

    const keptQuads = quads.filter((quad) =>
      !(quad.subject.equals(webIdNode) && quad.predicate.equals(storagePredicate)));
    keptQuads.push(DataFactory.quad(webIdNode, storagePredicate, DataFactory.namedNode(storageUrl)));

    const writer = new Writer({
      prefixes: {
        foaf: 'http://xmlns.com/foaf/0.1/',
        solid: 'http://www.w3.org/ns/solid/terms#',
        rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
      },
    });
    writer.addQuads(keptQuads);
    const updatedTurtle = await new Promise<string>((resolve, reject) => {
      writer.end((error, result) => error ? reject(error) : resolve(result));
    });

    await this.resourceStore.setRepresentation(
      identifier,
      new BasicRepresentation(guardStream(Readable.from(updatedTurtle)), identifier, 'text/turtle'),
    );
    this.provisionLogger.info(`Updated solid:storage in profile card ${cardUrl} to ${storageUrl}`);
  }
}
