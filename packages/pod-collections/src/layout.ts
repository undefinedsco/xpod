import type { PodModelDescriptor } from '@undefineds.co/models';
import { PodCollectionError } from './types.js';
import type { PodSubjectRow } from './types.js';

/**
 * topic 推导与行 IRI ↔ 键（`docs/pod-collections.md` §2.3、§2.7）。
 *
 * 只读 descriptor 的 `storage.base` / `storage.resourceIdPattern`：本文件里没有
 * 任何表清单、字段映射表或布局常量（N2）。三种形状：
 *
 * | `storage.base`             | `resourceIdPattern`        | 文档（topic）                      |
 * |----------------------------|----------------------------|------------------------------------|
 * | 文档（`…/credentials.ttl`） | `#{id}`                    | base 本身                          |
 * | 容器（`…/providers/`）      | `{key}.ttl`                | `base + key + '.ttl'`              |
 * | 容器（`…/providers/`）      | `{isProvidedBy.doc}#{key}` | 行所属 provider 的文档（scope 决定） |
 *
 * 第四种形状（`base = '/.data/'` + `{id}`，一行一文档）不在本期范围（§1.2）。
 */

export interface PodLayoutScope {
  provider?: string;
  instanceId?: string;
}

export interface PodLayoutInput {
  podUrl: string;
  /** 显式文档（绝对 URL 或相对 podUrl 的路径）。给了就不再推导。 */
  document?: string;
  scope?: PodLayoutScope;
}

const TEMPLATE_VARIABLE = /\{([^{}]+)\}/gu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function normalizePodUrl(podUrl: string): string {
  return podUrl.endsWith('/') ? podUrl : `${podUrl}/`;
}

/** 绝对 URL 直接用；否则按 podUrl 解析（相对路径不要求前导 `/`）。 */
export function resolvePodUrl(podUrl: string, value: string): string {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return value;
  return new URL(value.replace(/^\/+/u, ''), normalizePodUrl(podUrl)).toString();
}

export function templateVariables(pattern: string): string[] {
  return [...pattern.matchAll(TEMPLATE_VARIABLE)].map((match) => match[1] as string);
}

/** 行键 slot（模式里最后一个模板变量）的名字。 */
export function rowKeyVariable(pattern: string): string {
  const last = templateVariables(pattern).at(-1);
  if (!last) {
    throw new PodCollectionError(
      'layout_pattern_without_key',
      `resourceIdPattern "${pattern}" has no {…} key slot`,
    );
  }
  return last;
}

function splitOnKeySlot(pattern: string): { head: string; tail: string; slot: string } {
  const slot = `{${rowKeyVariable(pattern)}}`;
  const index = pattern.lastIndexOf(slot);
  return { head: pattern.slice(0, index), tail: pattern.slice(index + slot.length), slot };
}

/** `storage.base` 本身就是一个文档（最后一段带扩展名），而不是容器。 */
export function isDocumentBase(base: string): boolean {
  const lastSegment = base.replace(/\/+$/u, '').split('/').pop() ?? '';
  return lastSegment.includes('.');
}

function baseDirectory(base: string): string {
  if (base.endsWith('/')) return base;
  const slash = base.lastIndexOf('/');
  return slash < 0 ? '/' : base.slice(0, slash + 1);
}

/**
 * 文档（topic）解析。三种形状见文件头；无法机械推导时抛
 * `layout_document_required`，不猜布局。
 */
export function resolveTableDocument(
  descriptor: PodModelDescriptor,
  input: PodLayoutInput,
): string {
  const podUrl = normalizePodUrl(input.podUrl);
  if (input.document) return resolvePodUrl(podUrl, input.document);

  const base = descriptor.storage.base;
  const pattern = descriptor.storage.resourceIdPattern;
  if (!base || !pattern) {
    throw new PodCollectionError(
      'layout_missing_storage',
      `descriptor ${descriptor.uri} has no storage.base / resourceIdPattern`,
    );
  }

  // 形状 1：base 本身是文档，行是文档里的主语。
  if (isDocumentBase(base)) return resolvePodUrl(podUrl, base);

  // 形状 2：base 是容器，行键就是文档名（`{key}.ttl`，键 slot 前只有字面量）。
  const { head, tail } = splitOnKeySlot(pattern);
  if (!pattern.includes('#') && templateVariables(head).length === 0) {
    const key = input.scope?.instanceId ?? input.scope?.provider;
    if (!key) {
      throw new PodCollectionError(
        'layout_document_required',
        `descriptor ${descriptor.uri} stores one document per row key (${pattern}); pass document or scope`,
      );
    }
    return resolvePodUrl(podUrl, `${base}${head}${key}${tail}`);
  }

  // 形状 3：文档由另一个模板变量（如 `{isProvidedBy.doc}`）决定，descriptor 推不出来。
  throw new PodCollectionError(
    'layout_document_required',
    `descriptor ${descriptor.uri} stores rows across documents (${base}${pattern}); pass document explicitly`,
  );
}

/** 文档 URL 相对 podUrl 的 resource id（例如 `settings/credentials.ttl`）。 */
export function documentResourceId(documentUrl: string, podUrl: string): string {
  const root = normalizePodUrl(podUrl);
  if (documentUrl.startsWith(root)) return documentUrl.slice(root.length);
  return documentUrl.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/iu, '').replace(/^\/+/u, '');
}

/** 文档在表 base 下的相对 id（表列 `id` 的文档段），例如 `credentials.ttl`。 */
export function documentKeyOf(
  descriptor: PodModelDescriptor,
  documentUrl: string,
  podUrl: string,
): string {
  const relative = documentResourceId(documentUrl, podUrl);
  const baseDir = baseDirectory(descriptor.storage.base).replace(/^\/+/u, '');
  const key = relative.startsWith(baseDir) ? relative.slice(baseDir.length) : relative;
  if (!key) {
    throw new PodCollectionError(
      'layout_document_outside_base',
      `document ${documentUrl} is not under ${descriptor.storage.base}`,
    );
  }
  return key;
}

/**
 * 表列 `id`（base-relative resource id）的值：
 * `settings/credentials.ttl` + base `/settings/` + `#{id}` → `credentials.ttl#{key}`。
 * ORM 的 `updateById` / `deleteById` 收的就是这个值。
 */
export function resourceIdForRow(
  descriptor: PodModelDescriptor,
  documentUrl: string,
  podUrl: string,
  key: string,
): string {
  const pattern = descriptor.storage.resourceIdPattern;
  const documentKey = documentKeyOf(descriptor, documentUrl, podUrl);
  const { head, tail, slot } = splitOnKeySlot(pattern);
  if (templateVariables(pattern).length > 1) {
    throw new PodCollectionError(
      'layout_document_required',
      `resourceIdPattern "${pattern}" has template variables this layer cannot fill`,
    );
  }
  if (pattern.startsWith('#')) return `${documentKey}${pattern.replace(slot, key)}`;
  return `${head}${key}${tail}`;
}

/** 行主语 IRI：文档 + fragment slot（行就是文档时等于文档 URL）。 */
export function subjectIriForRow(
  descriptor: PodModelDescriptor,
  documentUrl: string,
  key: string,
): string {
  return descriptor.storage.resourceIdPattern.includes('#') ? `${documentUrl}#${key}` : documentUrl;
}

/** 行所属文档（去掉 fragment）。 */
export function documentOfIri(iri: string): string {
  const hash = iri.indexOf('#');
  return hash < 0 ? iri : iri.slice(0, hash);
}

/** 行主语 IRI：drizzle-solid 行上的 `@id` / `uri` / `subject`。 */
export function rowSubjectIriOf(row: PodSubjectRow): string | undefined {
  for (const candidate of [row['@id'], row.uri, row.subject]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

/** 行 resource id（drizzle-solid 的虚列 `id`）。 */
export function rowResourceIdOf(row: PodSubjectRow): string | undefined {
  return typeof row.id === 'string' && row.id.length > 0 ? row.id : undefined;
}

/**
 * 从行上取行键：把 `resourceIdPattern` 编译成正则，最后一个模板变量就是键。
 * `#{id}` → fragment；`{key}.ttl` → 文件名；`{isProvidedBy.doc}#{key}` → fragment；
 * `{yyyy}/{MM}/{dd}.ttl#{id}` → fragment。
 * 与 §2.7 一致：键只取行标识 slot，**不取 `uniqueBy`**。0.2.57 起 credential 的
 * `uniqueBy` 是真实列 `['id']`（旧值 `['service','providerId','secretType']` 引用了
 * 不存在的列且不唯一），但两者语义不同：`uniqueBy` 是语义唯一键，键 slot 是存储布局。
 * 官方 descriptor 已经出现不同形的情形 —— `aiModelDescriptor` 的 `uniqueBy` 也是
 * `['id']`，而它的键 slot 叫 `key`（`{isProvidedBy.doc}#{key}`），且 `id` 并不是一个
 * 有谓词列的字段。所以键只能从 `resourceIdPattern` 取。
 */
export function rowKeyOf(descriptor: PodModelDescriptor, row: PodSubjectRow): string | undefined {
  const resourceId = rowResourceIdOf(row);
  if (!resourceId) return undefined;
  return compileRowKeyPattern(descriptor.storage.resourceIdPattern).exec(resourceId)?.[1];
}

/**
 * 模板 → 正则：字面量先切出来再转义，模板变量替换成捕获组（最后一个变量是键）。
 * 不能「先整体转义再替换变量」—— 那会把变量前的转义反斜杠留在原处，生成非法正则。
 */
export function compileRowKeyPattern(pattern: string): RegExp {
  const matches = [...pattern.matchAll(TEMPLATE_VARIABLE)];
  const last = matches.at(-1);
  if (!last) {
    throw new PodCollectionError(
      'layout_pattern_without_key',
      `resourceIdPattern "${pattern}" has no {…} key slot`,
    );
  }
  let source = '^[\\s\\S]*?';
  let cursor = 0;
  for (const match of matches) {
    const index = match.index ?? 0;
    source += escapeRegExp(pattern.slice(cursor, index));
    source += match === last ? '([\\s\\S]+)' : '[\\s\\S]*?';
    cursor = index + match[0].length;
  }
  source += `${escapeRegExp(pattern.slice(cursor))}$`;
  return new RegExp(source, 'u');
}

/** 行是否属于该文档（一个表 = 一个文档；§2.3、§3.4）。 */
export function rowBelongsToDocument(
  descriptor: PodModelDescriptor,
  documentUrl: string,
  podUrl: string,
  row: PodSubjectRow,
): boolean {
  const document = documentOfIri(documentUrl);
  const subject = rowSubjectIriOf(row);
  if (subject) return documentOfIri(subject) === document;
  const resourceId = rowResourceIdOf(row);
  if (!resourceId) return false;
  const documentKey = documentKeyOf(descriptor, documentUrl, podUrl);
  return documentOfIri(resourceId).endsWith(documentKey);
}
