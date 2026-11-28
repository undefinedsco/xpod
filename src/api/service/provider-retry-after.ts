/** Parse the standard Retry-After delta-seconds or HTTP-date using the caller's clock. */
export function parseRetryAfter(value: string | null | undefined, now: Date): Date | undefined {
  const text = value?.trim();
  if (!text) {
    return undefined;
  }
  // Only HTTP dates are accepted here: Date.parse also accepts invalid header values like -1.
  const httpDate = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/u;
  const timestamp = /^\d+$/u.test(text)
    ? now.getTime() + Number(text) * 1000
    : httpDate.test(text) ? Date.parse(text.endsWith('GMT') ? text : `${text} GMT`) : Number.NaN;
  const date = new Date(Math.max(now.getTime(), timestamp));
  return Number.isFinite(date.getTime()) ? date : undefined;
}

/** Transport errors can expose either Fetch Headers or a plain header dictionary. */
export function retryAfterFromError(error: unknown): string | undefined {
  const headers = (error as { headers?: Headers | Record<string, unknown> } | null)?.headers;
  if (!headers) {
    return undefined;
  }
  if (typeof headers.get === 'function') {
    return headers.get('Retry-After') ?? undefined;
  }
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
  return typeof value === 'string' ? value : undefined;
}
