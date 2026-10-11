export function strictObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new Error('sanitized JSON fields mismatch');
  }
  return value as Record<string, unknown>;
}
