export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function readResponseMessage(value: unknown): string {
  return isRecord(value) && typeof value.message === 'string' ? value.message : '';
}

export function messageFromError(value: unknown, fallback: string): string {
  return value instanceof Error && value.message ? value.message : fallback;
}
