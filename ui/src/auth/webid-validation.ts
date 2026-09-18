/** Reject characters that URL parsing silently removes from a WebID identity. */
export function hasInvalidWebIdWhitespace(value: string): boolean {
  return value !== value.trim() || /[\r\n\t]/.test(value);
}
