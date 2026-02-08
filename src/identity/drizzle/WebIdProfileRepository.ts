/**
 * WebID Profile Repository
 *
 * 管理 WebID Profile 的托管，支持身份与存储分离架构
 */

import { eq } from 'drizzle-orm';
import type { IdentityDatabase } from './db';
import { getLoggerFor } from 'global-logger-factory';

const logger = getLoggerFor('WebIdProfileRepository');

export interface WebIdProfile {
  username: string;
  webidUrl: string;
  storageUrl?: string;
  storageMode: 'cloud' | 'local' | 'custom';
  oidcIssuer?: string;
  profileData?: Record<string, unknown>;
  accountId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWebIdProfileInput {
  username: string;
  storageMode?: 'cloud' | 'local' | 'custom';
  storageUrl?: string;
  accountId?: string;
}

export interface UpdateStorageInput {
  storageUrl: string;
  storageMode?: 'cloud' | 'local' | 'custom';
}

export class WebIdProfileRepository {
  private readonly baseUrl: string;

  constructor(
    private readonly db: IdentityDatabase,
    options: { baseUrl: string },
  ) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
  }

  /**
   * 创建 WebID Profile
   */
  async create(input: CreateWebIdProfileInput): Promise<WebIdProfile> {
    const { username, storageMode = 'cloud', storageUrl, accountId } = input;

    // 生成 WebID URL
    const webidUrl = `${this.baseUrl}/${username}/profile/card#me`;

    // 默认 storage URL
    const defaultStorageUrl = storageMode === 'cloud'
      ? `${this.baseUrl}/${username}/`
      : storageUrl;

    // 生成默认的 Profile 数据
    const profileData = this.generateDefaultProfile(username, webidUrl, defaultStorageUrl);

    const now = new Date();

    await this.db.insert(this.db.schema.webidProfiles).values({
      username,
      webidUrl,
      storageUrl: defaultStorageUrl,
      storageMode,
      oidcIssuer: this.baseUrl,
      profileData,
      accountId,
      createdAt: now,
      updatedAt: now,
    });

    logger.info(`Created WebID profile for ${username}: ${webidUrl}`);

    return {
      username,
      webidUrl,
      storageUrl: defaultStorageUrl,
      storageMode,
      oidcIssuer: this.baseUrl,
      profileData,
      accountId,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * 获取 WebID Profile
   */
  async get(username: string): Promise<WebIdProfile | null> {
    const results = await this.db
      .select()
      .from(this.db.schema.webidProfiles)
      .where(eq(this.db.schema.webidProfiles.username, username))
      .limit(1);

    if (results.length === 0) {
      return null;
    }

    const row = results[0];
    return {
      username: row.username,
      webidUrl: row.webidUrl,
      storageUrl: row.storageUrl ?? undefined,
      storageMode: (row.storageMode as 'cloud' | 'local' | 'custom') ?? 'cloud',
      oidcIssuer: row.oidcIssuer ?? undefined,
      profileData: row.profileData as Record<string, unknown> | undefined,
      accountId: row.accountId ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * 更新 Storage URL（用于 Local 节点更新指针）
   */
  async updateStorage(username: string, input: UpdateStorageInput): Promise<WebIdProfile | null> {
    const { storageUrl, storageMode } = input;

    const existing = await this.get(username);
    if (!existing) {
      return null;
    }

    // 更新 Profile 数据中的 storage
    const profileData = {
      ...(existing.profileData ?? {}),
      'solid:storage': { '@id': storageUrl },
    };

    const now = new Date();

    await this.db
      .update(this.db.schema.webidProfiles)
      .set({
        storageUrl,
        storageMode: storageMode ?? existing.storageMode,
        profileData,
        updatedAt: now,
      })
      .where(eq(this.db.schema.webidProfiles.username, username));

    logger.info(`Updated storage for ${username}: ${storageUrl}`);

    return {
      ...existing,
      storageUrl,
      storageMode: storageMode ?? existing.storageMode,
      profileData,
      updatedAt: now,
    };
  }

  /**
   * 删除 WebID Profile
   */
  async delete(username: string): Promise<boolean> {
    const result = await this.db
      .delete(this.db.schema.webidProfiles)
      .where(eq(this.db.schema.webidProfiles.username, username));

    // drizzle 返回的结果格式因数据库而异
    return true;
  }

  /**
   * 生成 WebID Profile 的 Turtle 格式
   */
  generateProfileTurtle(profile: WebIdProfile): string {
    const { webidUrl, storageUrl, oidcIssuer } = profile;

    return `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
@prefix solid: <http://www.w3.org/ns/solid/terms#>.

<${webidUrl}>
    a foaf:Person;
    solid:oidcIssuer <${oidcIssuer}>${storageUrl ? `;
    solid:storage <${storageUrl}>` : ''}.
`;
  }

  /**
   * 生成默认的 Profile 数据（JSON-LD 格式）
   */
  private generateDefaultProfile(
    username: string,
    webidUrl: string,
    storageUrl?: string,
  ): Record<string, unknown> {
    const profile: Record<string, unknown> = {
      '@context': {
        foaf: 'http://xmlns.com/foaf/0.1/',
        solid: 'http://www.w3.org/ns/solid/terms#',
      },
      '@id': webidUrl,
      '@type': 'foaf:Person',
      'solid:oidcIssuer': { '@id': this.baseUrl },
    };

    if (storageUrl) {
      profile['solid:storage'] = { '@id': storageUrl };
    }

    return profile;
  }
}
