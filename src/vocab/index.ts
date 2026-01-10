/**
 * Vocabulary 统一导出
 *
 * 使用方式:
 * ```typescript
 * import { UDFS, DCTerms, LDP } from '@/vocab';
 *
 * // 使用 Class
 * const type = UDFS.Credential;  // 'https://undefineds.co/ns#Credential'
 *
 * // 使用 Property
 * const prop = UDFS.apiKey;  // 'https://undefineds.co/ns#apiKey'
 *
 * // 动态构建 URI
 * const custom = UDFS('CustomTerm');  // 'https://undefineds.co/ns#CustomTerm'
 *
 * // 用于 drizzle-solid
 * import { UDFS_NAMESPACE } from '@/vocab';
 * const table = podTable('Credential', {...}, {
 *   type: UDFS.Credential,
 *   namespace: UDFS_NAMESPACE,
 * });
 * ```
 */

// UDFS 词汇表
export { UDFS, UDFS_NAMESPACE } from './udfs';

// 外部标准词汇表
export { DCTerms, LDP, Schema, RDF, RDFS, XSD, FOAF, ACL, Solid } from './external';
