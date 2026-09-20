import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AnyPodTable } from '@undefineds.co/drizzle-solid';
import { credentialDescriptor, credentialResource } from '@undefineds.co/models';
import {
  assertDescriptorTableAlignment,
  descriptorFieldsWithoutColumn,
  fieldBindings,
  identityFieldOf,
  mapSubjectRows,
  tableColumnsWithoutDescriptorField,
  writeOnlyFields,
} from '../src/mapping.js';
import { resolveTableDocument } from '../src/layout.js';
import { stripVirtualProps } from '../src/diff.js';
import type { PodDocumentFeed } from '../src/types.js';

/**
 * 守卫测试（§8.5）：① 字段漂移 ② 主入口在无 DOM/React 的 node 环境可 import
 * ③ 源码无 setInterval（N1） ④ 源码没有第二份 schema 规则 / 表清单（N2）。
 */

const SRC_DIR = new URL('../src/', import.meta.url);
const sourceFiles = readdirSync(SRC_DIR).filter((file) => file.endsWith('.ts'));

function sourceOf(file: string): string {
  return readFileSync(new URL(file, SRC_DIR), 'utf8');
}

/** 去掉注释后再扫描（注释里说明文档、引用证据是允许的，代码里出现才是违规）。 */
function codeOf(file: string): string {
  return sourceOf(file)
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
}

describe('guard: descriptor ↔ drizzle table drift (§2.7)', () => {
  const table = credentialResource as unknown as AnyPodTable;
  const columns = Object.keys(table.getMapping().columns);

  it('class comes from the same source on both sides', () => {
    expect(credentialDescriptor.class).toBe(table.getType());
    expect(() => assertDescriptorTableAlignment(credentialDescriptor, table)).not.toThrow();
  });

  it('locks the fields the collection can actually resolve (by predicate)', () => {
    // 集合的字段→列绑定按**谓词**解析，不按字段名。0.2.57 起 35 个字段一一落到同名
    // 列上；唯一的例外是行标识 `id`：它的谓词是 `ns#id`，不落在任何谓词列上（表的
    // `id` 是 `@id` 虚列），所以它不进这张表，由 `rowKeyOf()` 从行键填。
    const mapped = [...fieldBindings(credentialDescriptor, table).values()]
      .filter((binding) => binding.column !== undefined)
      .map((binding) => `${binding.field}->${binding.column}`)
      .sort();
    expect(mapped).toEqual([
      'accountLabel->accountLabel',
      'apiKey->apiKey',
      'appliedAt->appliedAt',
      'appliedOn->appliedOn',
      'appliedTo->appliedTo',
      'authMode->authMode',
      'baseUrl->baseUrl',
      'clientCredentialId->clientCredentialId',
      'createdAt->createdAt',
      'encryptedSecret->encryptedSecret',
      'encryptionAlgorithm->encryptionAlgorithm',
      'expiresAt->expiresAt',
      'failCount->failCount',
      'isDefault->isDefault',
      'keyVersion->keyVersion',
      'label->label',
      'lastRefreshAt->lastRefreshAt',
      'lastUsedAt->lastUsedAt',
      'metadata->metadata',
      'oauthAccessToken->oauthAccessToken',
      'oauthExpiresAt->oauthExpiresAt',
      'oauthRefreshToken->oauthRefreshToken',
      'offeringId->offeringId',
      'organizationId->organizationId',
      'projectId->projectId',
      'provider->provider',
      'proxyUrl->proxyUrl',
      'rateLimitResetAt->rateLimitResetAt',
      'reauthRequired->reauthRequired',
      'scopes->scopes',
      'secretPayload->secretPayload',
      'service->service',
      'status->status',
      'storageMode->storageMode',
      'wrappedDataKey->wrappedDataKey',
    ]);
    expect(descriptorFieldsWithoutColumn(credentialDescriptor, table)).toEqual([]);
    expect(identityFieldOf(credentialDescriptor)).toBe('id');
  });

  it('locks 0.2.57 full coverage: zero drift in both directions, uniqueBy is a real column', () => {
    // 0.2.56 → 0.2.57 的变化（这条测试就是那次修复的回归锁）。0.2.56 的事实是：
    // descriptor 19 个字段 / 表 36 列，18 个 by-predicate 表独有列，descriptor 独有
    // `providerId`（谓词落在 `provider` 列上，按名不算命中）与 `secretType`（无承载列），
    // `uniqueBy` 引用 `['service','providerId','secretType']` 三个非唯一/非列值。
    // 0.2.57 补齐为 36 / 36：
    //   · 新增 18 个字段，正好覆盖 0.2.56 的 18 个 by-predicate 表独有列 —— appliedAt /
    //     appliedOn / appliedTo / baseUrl / clientCredentialId / createdAt / failCount /
    //     isDefault / lastUsedAt / metadata / oauthAccessToken / oauthExpiresAt /
    //     oauthRefreshToken / offeringId / organizationId / projectId / proxyUrl /
    //     rateLimitResetAt；
    //   · `providerId` 改名为真实列名 `provider`（谓词不变，是改名不是新增）；
    //   · 删除没有承载列的 `secretType`；
    //   · `uniqueBy` 从引用非列的 `['service','providerId','secretType']` 改成真实列 `['id']`。
    // 精确计数 + 双向空集：任何一侧将来增删字段/列都会让下面某条断言失败 —— 守卫
    // 不能退化成「descriptor 说什么就是什么」。
    expect(Object.keys(credentialDescriptor.fields)).toHaveLength(36);
    expect(columns).toHaveLength(36);
    // 表里有、descriptor 没有对应**谓词**的列：0 个。
    expect(tableColumnsWithoutDescriptorField(credentialDescriptor, table)).toEqual([]);
    // descriptor 声明了、表里没有对应**谓词**的字段：0 个（行标识 `id` 由行本身承载，不算）。
    expect(descriptorFieldsWithoutColumn(credentialDescriptor, table)).toEqual([]);
    // 按**列名**看（doc §2.7 事实 2 的口径）：表独有 0 列，descriptor 独有 0 字段。
    const byName = columns.filter((column) => column !== 'id' && !(column in credentialDescriptor.fields));
    expect(byName).toEqual([]);
    const descriptorOnly = Object.keys(credentialDescriptor.fields)
      .filter((field) => !columns.includes(field));
    expect(descriptorOnly).toEqual([]);
    // §2.7 事实 1 的现状：uniqueBy 是真实列（`id`），所以它指向的列必然存在。
    expect(credentialDescriptor.uniqueBy).toEqual(['id']);
    expect(credentialDescriptor.uniqueBy.length).toBeGreaterThan(0);
    for (const field of credentialDescriptor.uniqueBy) {
      expect(columns).toContain(field);
    }
    // 只写字段（`secret: true`）的精确集合：写得到、读不回（§2.1）。
    expect([...writeOnlyFields(credentialDescriptor)].sort()).toEqual([
      'apiKey',
      'encryptedSecret',
      'oauthAccessToken',
      'oauthRefreshToken',
      'secretPayload',
      'wrappedDataKey',
    ]);
  });

  it('exposes exactly the descriptor projection, never the table columns', () => {
    const document = resolveTableDocument(credentialDescriptor, { podUrl: 'https://pod.test/alice/' });
    const rows = mapSubjectRows(credentialDescriptor, table, [{
      id: 'credentials.ttl#openai-1',
      '@id': `${document}#openai-1`,
      service: 'ai',
      provider: 'https://pod.test/alice/settings/providers/openai.ttl#this',
      // 0.2.57 起这些列都是 descriptor 字段：**应该**出现在行里（旧版曾是「表独有」）。
      offeringId: 'api-platform',
      metadata: '{"priority":7}',
      baseUrl: 'https://api.openai.com',
      isDefault: true,
      failCount: 3,
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      label: 'OpenAI',
      status: 'active',
      // 既不是表列也不是 descriptor 字段的键：绝不整行透传。
      mysteryColumn: 'not-declared-anywhere',
      // 只写字段：写得到、读不回。
      apiKey: 'sk-secret',
      oauthRefreshToken: 'rt-secret',
    }]);
    expect(rows).toHaveLength(1);
    const row = stripVirtualProps(rows[0] as Record<string, unknown>);
    expect(Object.keys(row).sort()).toEqual([
      '@id',
      'baseUrl',
      'createdAt',
      'failCount',
      'id',
      'isDefault',
      'label',
      'metadata',
      'offeringId',
      'provider',
      'service',
      'status',
    ]);
    // 0.2.57 里表列 ⊂ descriptor 字段，所以「表独有列泄漏」已不可能发生；守卫改为
    // 直接锁住**投影的准入规则**：非 descriptor 键（将来任何新增表列都会先落在这里）
    // 一个都不许出现在行里。
    expect(Object.keys(row)).not.toContain('mysteryColumn');
    // 暴露的每个字段在 descriptor 与表两边都能找到（或者就是行标识本身）。
    for (const key of Object.keys(row)) {
      if (key === 'id' || key === '@id') continue;
      expect(Object.keys(credentialDescriptor.fields)).toContain(key);
      expect(fieldBindings(credentialDescriptor, table).get(key)?.column).toBeDefined();
    }
    // secret 字段不投影（§2.1）——精确集合，不是抽查。
    for (const secret of writeOnlyFields(credentialDescriptor)) {
      expect(Object.keys(row)).not.toContain(secret);
    }
  });
});

describe('guard: main entry is DOM-free and React-free', () => {
  it('imports in a node environment without window/document', async () => {
    expect(typeof globalThis.window).toBe('undefined');
    expect(typeof globalThis.document).toBe('undefined');
    const entry = await import('../src/index.js');
    expect(typeof entry.definePodCollection).toBe('function');
    expect(typeof entry.podCollectionInternals).toBe('function');
    // `PodDocumentFeed` 是结构化端口：`watch(topic, listener)` 一个方法就够（§2.2）。
    const feed: PodDocumentFeed = { watch: () => () => {} };
    expect(typeof feed.watch).toBe('function');
  });

  it('never imports React outside the ./react entry', () => {
    for (const file of sourceFiles) {
      if (file === 'react.ts') continue;
      expect(codeOf(file), file).not.toMatch(/from '(react|react-dom|@tanstack\/react-db)'/u);
    }
    expect(codeOf('react.ts')).toMatch(/@tanstack\/react-db/u);
  });
});

describe('guard: no polling (N1)', () => {
  it('has no recurring timer in the package source', () => {
    for (const file of sourceFiles) {
      expect(codeOf(file), file).not.toMatch(/setInterval|setImmediate|requestAnimationFrame/u);
    }
  });
});

describe('guard: no second copy of schema rules (N2)', () => {
  it('contains no model namespace, document layout or table list', () => {
    const banned = [
      // 命名空间 IRI / 文档路径 / 表名都是 schema 事实，只能从 descriptor 与表读。
      // （`@undefineds.co/models` 的 import specifier 不算：包名不是布局常量。）
      'https://undefineds.co',
      '.ttl',
      'settings/',
      'providers/',
      'isProvidedBy',
      'credentialResource',
      'credentialDescriptor',
      'aiProviderResource',
      'aiModelResource',
      'gatewayAccessKey',
    ];
    for (const file of sourceFiles) {
      const code = codeOf(file);
      for (const token of banned) {
        expect(code, `${file} must not contain "${token}"`).not.toContain(token);
      }
    }
  });

  it('only ever imports types from @undefineds.co/models', () => {
    for (const file of sourceFiles) {
      const code = codeOf(file);
      const imports = [...code.matchAll(/import\s+([^;]*?)from\s+'@undefineds\.co\/models'/gu)];
      for (const [, clause] of imports) {
        expect(clause?.trim().startsWith('type '), `${file}: ${clause}`).toBe(true);
      }
    }
  });

  it('derives every schema fact from the descriptor or the table at runtime', () => {
    // 布局事实（storage.base / resourceIdPattern）只有 layout.ts 读。
    const layoutReaders = sourceFiles.filter((file) => /\.storage\b/u.test(codeOf(file))).sort();
    expect(layoutReaders).toEqual(['layout.ts', 'mapping.ts']);
    // 字段声明只有投影层（mapping）与 mutation 映射读；都是运行时读 descriptor，
    // 没有任何一份写死的字段/表清单。
    const fieldReaders = sourceFiles.filter((file) => /\.fields\b/u.test(codeOf(file))).sort();
    expect(fieldReaders).toEqual(['mapping.ts', 'mutations.ts']);
  });
});
