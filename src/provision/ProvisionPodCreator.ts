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
  ConflictHttpError,
} from '@solid/community-server';
import { ProvisionCodeCodec } from './ProvisionCodeCodec';
import type { WebIdProfileRepository } from '../identity/drizzle/WebIdProfileRepository';

function joinUrlPath(baseUrl: string, relativePath: string): string {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/u, '');
  const normalizedRelativePath = relativePath.replace(/^\/+/u, '');
  return `${normalizedBaseUrl}/${normalizedRelativePath}`;
}

export interface ProvisionPodCreatorArgs extends BasePodCreatorArgs {
  /** 与 ProvisionHandler 使用相同的 baseUrl 派生签名密钥 */
  provisionBaseUrl?: string;
  /** Optional Cloud profile repository used to reconcile solid:storage after remote provisioning */
  webIdProfileRepo?: WebIdProfileRepository;
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
  private readonly webIdProfileRepo?: WebIdProfileRepository;

  public constructor(args: ProvisionPodCreatorArgs) {
    super(args);
    this.codec = new ProvisionCodeCodec(args.provisionBaseUrl ?? args.baseUrl);
    this.webIdProfileRepo = args.webIdProfileRepo;
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

    this.provisionLogger.info(`Provisioning pod on remote SP: ${payload.spUrl}`);

    // 1. 确定 podName
    const podName = input.name;
    if (!podName) {
      throw new Error('Pod name is required for remote provisioning');
    }

    // 2. 回调 SP 创建 Pod
    const callbackUrl = `${payload.spUrl.replace(/\/$/, '')}/provision/pods`;
    const spResponse = await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${payload.serviceToken}`,
      },
      body: JSON.stringify({ podName }),
    });

    if (!spResponse.ok) {
      const errBody = await spResponse.text();
      this.provisionLogger.error(`SP callback failed: ${spResponse.status} ${errBody}`);
      throw new Error(`Failed to create pod on SP: ${spResponse.status}`);
    }

    const spResult = await spResponse.json() as { podUrl?: string };

    // storage URL 优先用 Cloud 分配的子域名，回调用实际地址
    const storageBase = payload.spDomain
      ? `https://${payload.spDomain}`
      : payload.spUrl.replace(/\/$/, '');
    const canonicalStorageUrl = `${storageBase}/${podName}/`;
    const podUrl = spResult.podUrl || canonicalStorageUrl;

    // 3. 生成 WebID（指向 Cloud，storage 指向 SP）
    const webId = input.webId ?? `${this.baseUrl}${podName}/profile/card#me`;

    // 4. 链接 WebID 到账户 + 在本地 PodStore 记录
    // base.path 必须在 Cloud 的 identifier space 内（CSS PodStore 会检查），
    // 所以用 Cloud 本地路径；真实的 SP storage URL 通过 podUrl 返回。
    const localBase = this.identifierGenerator.generate(podName);
    const podSettings = {
      ...input.settings,
      base: localBase,
      webId,
      oidcIssuer: this.baseUrl,
    };

    const webIdLink = await this.handleWebId(!input.webId, webId, input.accountId, podSettings);
    const podId = await this.createPod(input.accountId, podSettings, !input.name, webIdLink);

    if (!input.webId && this.webIdProfileRepo) {
      try {
        await this.webIdProfileRepo.updateStorage(podName, {
          storageUrl: canonicalStorageUrl,
          storageMode: 'local',
        });
      } catch (error) {
        this.provisionLogger.warn(`Failed to reconcile storage pointer for ${podName}: ${(error as Error).message}`);
      }
    }

    this.provisionLogger.info(`Provisioned pod ${podName} on SP ${payload.spUrl}, podUrl: ${podUrl}`);

    return {
      podUrl,
      webId,
      podId,
      webIdLink,
    };
  }

  private async handleStandardPodCreate(input: PodCreatorInput): Promise<PodCreatorOutput> {
    const totalStarted = Date.now();
    const baseIdentifier = this.generateBaseIdentifier(input.name);
    const webId = input.webId ?? joinUrlPath(baseIdentifier.path, this.relativeWebIdPath);
    const inputSettings = input.settings as Record<string, unknown> | undefined;
    const oidcIssuer = typeof inputSettings?.oidcIssuer === 'string' ? inputSettings.oidcIssuer : this.baseUrl;
    const podSettings = {
      ...inputSettings,
      base: baseIdentifier,
      webId,
      oidcIssuer,
    };

    const webIdStarted = Date.now();
    const webIdLink = await this.handleWebId(!input.webId, webId, input.accountId, podSettings);
    const webIdElapsed = Date.now() - webIdStarted;

    const podStarted = Date.now();
    let podId: string;
    try {
      podId = await this.createPod(input.accountId, podSettings, !input.name, webIdLink);
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
      webIdLink,
    };
  }
}
