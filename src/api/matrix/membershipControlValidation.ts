/**
 * Bounded private validation primitives shared by the Matrix membership control-state parsers
 * (`membershipOperation` and `membershipReadGrant`). These are the same strict predicates both
 * modules previously duplicated; behaviour is preserved exactly. No shared Solid schema, no
 * general utility layering and no new dependency.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function hasExactKeys(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === fields.length && actual.every(key => typeof key === 'string' && fields.includes(key));
}
export function isNonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
export function isHttpIri(value: unknown): value is string {
  if (!isNonblank(value) || value.trim() !== value) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch { return false; }
}
export function isMilliseconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
