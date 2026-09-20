import type { AnyPodTable } from '@undefineds.co/drizzle-solid';
import type { PodModelDescriptor, PodModelFieldDescriptor } from '@undefineds.co/models';
import { PodCollectionError } from './types.js';
import type { PodSubjectRow, RowOf } from './types.js';
import { rowKeyOf, rowKeyVariable } from './layout.js';

/**
 * RDF ↔ 行映射（`docs/pod-collections.md` §2.4）。
 *
 * 映射的唯一来源是 **descriptor 的字段声明**：`fields[*].predicate` 决定哪个表列
 * 承载该字段（列名由 drizzle 表的 mapping 给出，不由字段名猜）。两个 0.2.57 实测的
 * 证据：`createdAt` 经 `dcterms:created` 落到 `createdAt` 列（谓词不在 `ns#` 下），
 * 而行标识字段 `id` 的谓词是 `ns#id`、**不**落到表里那个同名的 `id` 列上（那是 `@id`
 * 虚列）—— 所以按名绑定会在第二个例子上直接错。字段类型只由 `fields[*].type` 决定，
 * **不从 term 类型反推**（§2.4 边界 1：以 `http(s)://` 开头的 `string` 会被写成
 * named node）。
 *
 * 字面量 datatype 按 drizzle-solid 的 SPARQL helper 规则
 * （`node_modules/@undefineds.co/drizzle-solid/dist/esm/core/sparql/helpers.js`
 * 的 `buildLiteralTerm`）：整数 `xsd:integer`、非整数 `xsd:decimal`、`xsd:boolean`、
 * `xsd:dateTime`。注意同一文件的 `formatValue()`（写路径）对整数发的是**无 datatype**
 * 的字面量，两者并不一致；本层按 §2.4 表格取 `buildLiteralTerm` 的规则，写路径仍完全
 * 交给 drizzle-solid 自己格式化。
 */

const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** RDF term（只覆盖本层会产生的两种）。 */
export interface PodRdfTerm {
  termType: 'NamedNode' | 'Literal';
  value: string;
  datatype?: string;
}

export interface PodFieldBinding {
  field: string;
  descriptor: PodModelFieldDescriptor;
  /** 承载该字段的表列；descriptor 声明了但表里没有对应谓词时为 undefined。 */
  column: string | undefined;
}

/** 表列 → 谓词（跳过 `@id` 虚列）。 */
export function tableColumnPredicates(table: AnyPodTable): Map<string, string> {
  const mapping = table.getMapping();
  const predicates = new Map<string, string>();
  for (const [column, entry] of Object.entries(mapping.columns)) {
    if (entry.predicate === '@id') continue;
    predicates.set(column, entry.predicate);
  }
  return predicates;
}

/** descriptor 字段 → 承载它的表列（按谓词，不按字段名）。 */
export function fieldBindings(
  descriptor: PodModelDescriptor,
  table: AnyPodTable,
): Map<string, PodFieldBinding> {
  const byPredicate = new Map<string, string>();
  for (const [column, predicate] of tableColumnPredicates(table)) {
    byPredicate.set(predicate, column);
  }
  const bindings = new Map<string, PodFieldBinding>();
  for (const [field, fieldDescriptor] of Object.entries(descriptor.fields)) {
    bindings.set(field, { field, descriptor: fieldDescriptor, column: byPredicate.get(fieldDescriptor.predicate) });
  }
  return bindings;
}

/**
 * 行标识字段：`resourceIdPattern` 的 `{…}` 键 slot 名（`#{id}` → `id`）。
 * 它由 drizzle-solid 的虚列 `id` / `@id` 承载，不落在任何谓词列上。
 */
export function identityFieldOf(descriptor: PodModelDescriptor): string {
  return rowKeyVariable(descriptor.storage.resourceIdPattern);
}

/**
 * descriptor 声明了、但表里找不到对应谓词的字段（§2.7 的漂移面）。
 * 行标识字段不算：它由行本身承载（`mapSubjectRows` 用行键填它）。
 */
export function descriptorFieldsWithoutColumn(
  descriptor: PodModelDescriptor,
  table: AnyPodTable,
): string[] {
  const identity = identityFieldOf(descriptor);
  return [...fieldBindings(descriptor, table).values()]
    .filter((binding) => binding.column === undefined && binding.field !== identity)
    .map((binding) => binding.field)
    .sort();
}

/** 表里有、但 descriptor 没声明的列（§2.7 的漂移面）。 */
export function tableColumnsWithoutDescriptorField(
  descriptor: PodModelDescriptor,
  table: AnyPodTable,
): string[] {
  const declaredPredicates = new Set(
    Object.values(descriptor.fields).map((field) => field.predicate),
  );
  return [...tableColumnPredicates(table)]
    .filter(([, predicate]) => !declaredPredicates.has(predicate))
    .map(([column]) => column)
    .sort();
}

/**
 * 类过滤的显式化（§2.4 边界 2）：行准入以 descriptor 的 `class` 为准，而 drizzle 的
 * 读把它编译成 `?subject rdf:type <class>`（表 options 的 `type`）。两者必须同源，
 * 否则读回来的行与 descriptor 不是一套 schema —— 抛错而不是静默接受。
 */
export function assertDescriptorTableAlignment(
  descriptor: PodModelDescriptor,
  table: AnyPodTable,
): void {
  const tableClass = table.getType();
  if (descriptor.class !== tableClass) {
    throw new PodCollectionError(
      'mapping_class_mismatch',
      `descriptor ${descriptor.uri} declares class ${descriptor.class} but table ${table.config.name} reads ${tableClass}`,
    );
  }
}

/**
 * 只写字段（`secret: true`）：**写入可以带、读取永远读不回**。
 *
 * §2.1 把投影定义为「descriptor 的非 secret 字段」，所以这些字段既不在
 * `mapSubjectRows()` 的行里，也不可能出现在服务端投影里。这个集合是那条规则的
 * 唯一来源：读写两侧（`mapSubjectRows()` 与 §4.2 的确认协议）都从它取，避免
 * 「哪边算 secret」出现第二份判断。
 *
 * 特别注意它与「descriptor 声明了但表里没有列」的字段（§2.7 的漂移面）不是一回事：
 * 后者是**可读**字段，只是当前不可投影，语义上仍要求出现在服务端行里。
 */
export function writeOnlyFields(descriptor: PodModelDescriptor): ReadonlySet<string> {
  return new Set(
    Object.entries(descriptor.fields)
      .filter(([, field]) => field.secret === true)
      .map(([name]) => name),
  );
}

/**
 * 投影后的字段顺序：按谓词排序（§3.2 的投影哈希要求确定性，与字段声明顺序无关）。
 */
export function projectionFieldOrder(descriptor: PodModelDescriptor): string[] {
  // The projection is the *readable* row: `secret: true` fields never come back
  // from a read (see `writeOnlyFields`), so counting them would make the row the
  // store completed differ from the row we wrote and turn our own echo into a
  // spurious update.
  const writeOnly = writeOnlyFields(descriptor);
  return Object.entries(descriptor.fields)
    .filter(([field]) => !writeOnly.has(field))
    .sort(([, left], [, right]) => (left.predicate < right.predicate ? -1 : left.predicate > right.predicate ? 1 : 0))
    .map(([field]) => field);
}

function isRdfTerm(value: unknown): value is PodRdfTerm {
  return typeof value === 'object' && value !== null
    && typeof (value as { termType?: unknown }).termType === 'string'
    && typeof (value as { value?: unknown }).value === 'string';
}

function termDatatypeOf(value: PodRdfTerm): string | undefined {
  const datatype = value.datatype;
  if (!datatype) return undefined;
  return typeof datatype === 'string' ? datatype : (datatype as { value?: string }).value;
}

function coerceScalar(field: PodModelFieldDescriptor, input: unknown): unknown {
  if (input === null || input === undefined || input === '') return undefined;
  const term = isRdfTerm(input) ? input : undefined;
  const raw: unknown = term ? term.value : input;
  const datatype = term ? termDatatypeOf(term) : undefined;

  switch (field.type) {
    case 'uri':
      return term && term.termType !== 'NamedNode' ? String(raw) : String(raw);
    case 'string':
    case 'text':
      return typeof raw === 'boolean' || typeof raw === 'number' ? String(raw) : String(raw);
    case 'number': {
      if (typeof raw === 'number') return raw;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      return Boolean(raw);
    case 'timestamp': {
      const date = raw instanceof Date ? raw : new Date(String(raw));
      return Number.isNaN(date.getTime()) ? undefined : date;
    }
    case 'json': {
      // JSON 的序列化细节属于 drizzle-solid（§2.4）：非 term 输入（ORM 已解码的值）
      // 原样透传；term 输入（本层 valueToTerm 的产物）解析回值，解析不了就当字符串。
      if (!term) return input;
      if (datatype && !/#json(Array)?$/u.test(datatype) && raw === '') return undefined;
      try {
        return JSON.parse(String(raw));
      } catch {
        return raw;
      }
    }
    default:
      return raw;
  }
}

/** 值 → 行字段值；同时接受 drizzle-solid 已解码的值与 RDF term（§2.4）。 */
export function coerceFieldValue(field: PodModelFieldDescriptor, input: unknown): unknown {
  if (field.array) {
    if (input === undefined || input === null) return undefined;
    const list = Array.isArray(input) ? input : [input];
    const values = list
      .map((item) => coerceScalar(field, item))
      .filter((item) => item !== undefined);
    return values.length > 0 ? values : undefined;
  }
  return coerceScalar(field, input);
}

/** 值 → RDF term（§2.4；datatype 规则见文件头）。 */
export function valueToTerm(field: PodModelFieldDescriptor, value: unknown): PodRdfTerm | undefined {
  if (value === undefined || value === null) return undefined;
  if (field.type === 'uri') return { termType: 'NamedNode', value: String(value) };
  if (field.type === 'number') {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return undefined;
    return {
      termType: 'Literal',
      value: String(numeric),
      datatype: Number.isInteger(numeric) ? `${XSD}integer` : `${XSD}decimal`,
    };
  }
  if (field.type === 'boolean') {
    return { termType: 'Literal', value: value ? 'true' : 'false', datatype: `${XSD}boolean` };
  }
  if (field.type === 'timestamp') {
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) return undefined;
    return { termType: 'Literal', value: date.toISOString(), datatype: `${XSD}dateTime` };
  }
  if (field.type === 'json') {
    return { termType: 'Literal', value: typeof value === 'string' ? value : JSON.stringify(value) };
  }
  const text = String(value);
  // §2.4 边界 1：`string` 字段的值以 http(s):// 开头时会被写成 named node。
  if (/^https?:\/\//u.test(text)) return { termType: 'NamedNode', value: text };
  return { termType: 'Literal', value: text };
}

/** array 字段：每个元素一个 term（每元素一条三元组，§2.4）。 */
export function valuesToTerms(
  field: PodModelFieldDescriptor,
  value: unknown,
): PodRdfTerm[] {
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((item) => valueToTerm(field, item))
    .filter((term): term is PodRdfTerm => term !== undefined);
}

/**
 * 主语行 → 集合行（`RowOf<D>`）：只投影 descriptor 的非 `secret` 字段，
 * `secret: true` 的字段默认不出现在行里（§2.1）。文档归属由读原语（`read.ts`）
 * 决定，这里只做投影与键提取。
 */
export function mapSubjectRows<D extends PodModelDescriptor>(
  descriptor: D,
  table: AnyPodTable,
  subjects: readonly PodSubjectRow[],
): RowOf<D>[] {
  const bindings = fieldBindings(descriptor, table);
  const identityField = identityFieldOf(descriptor);
  const writeOnly = writeOnlyFields(descriptor);
  const rows: RowOf<D>[] = [];
  for (const subject of subjects) {
    const key = rowKeyOf(descriptor, subject);
    if (key === undefined) continue;
    const row: Record<string, unknown> = { id: key };
    if (identityField !== 'id') row[identityField] = key;
    const subjectIri = subject['@id'] ?? subject.uri ?? subject.subject;
    if (typeof subjectIri === 'string') row['@id'] = subjectIri;
    for (const binding of bindings.values()) {
      if (writeOnly.has(binding.field)) continue;
      if (binding.column === undefined) continue;
      const value = coerceFieldValue(binding.descriptor, subject[binding.column]);
      if (value !== undefined) row[binding.field] = value;
    }
    rows.push(row as RowOf<D>);
  }
  return rows;
}

/**
 * 集合行 → drizzle 写负载（列名 → 值），供 `insert().values()` / `updateById()`。
 * `array + uri` 字段由调用方走 `writeField()` 的 PATCH 旁路，不进 ORM（§4.1）。
 * 返回的负载总是包含行标识列 `id`（表列 `id` 是 base-relative resource id）。
 */
export function descriptorRowToColumnValues(
  descriptor: PodModelDescriptor,
  table: AnyPodTable,
  row: Record<string, unknown>,
  options: { resourceId: string; includeField?: (field: string) => boolean },
): Record<string, unknown> {
  const bindings = fieldBindings(descriptor, table);
  const values: Record<string, unknown> = { id: options.resourceId };
  for (const [field, value] of Object.entries(row)) {
    if (field === 'id' || field === '@id') continue;
    const binding = bindings.get(field);
    if (!binding || binding.column === undefined) continue;
    if (options.includeField && !options.includeField(field)) continue;
    values[binding.column] = value;
  }
  return values;
}

/** 该字段是否走 §4.1 的 PATCH 旁路：`array: true` + `type: 'uri'`。 */
export function isUriArrayField(field: PodModelFieldDescriptor): boolean {
  return field.array === true && field.type === 'uri';
}

/** descriptor 里所有走 PATCH 旁路的字段。 */
export function uriArrayFields(descriptor: PodModelDescriptor): string[] {
  return Object.entries(descriptor.fields)
    .filter(([, field]) => isUriArrayField(field))
    .map(([name]) => name);
}
