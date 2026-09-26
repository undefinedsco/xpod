/**
 * Reading a JSON endpoint that a fixture has just started.
 *
 * The helpers in this directory poll a node they started seconds ago, so a transport failure
 * (connection refused, reset, DNS, timeout) is a *timing* fact, not an answer: treating it as a
 * verdict is what makes live fixture flows look flaky. An HTTP response is an answer, so it is
 * never retried - it is returned as an error naming the status and the body's first line.
 */
export interface FetchJsonOptions {
  /** Total tries, including the first. */
  attempts?: number;
  /** Base delay between tries; a random jitter of up to this much is added. */
  delayMs?: number;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** An HTTP answer: the endpoint is up and said no, so retrying cannot change it. */
class HttpAnswerError extends Error {}

export interface FetchJsonResult<T> {
  value: T;
  attempts: number;
}

export async function fetchJsonWithRetry<T>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<FetchJsonResult<T>> {
  const attempts = options.attempts ?? 10;
  const delayMs = options.delayMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        const body = (await response.text().catch(() => '')).split('\n')[0]?.trim().slice(0, 160) ?? '';
        throw new HttpAnswerError(`${url} answered ${response.status}${body ? `: ${body}` : ''}`);
      }
      return { value: await response.json() as T, attempts: attempt };
    } catch (error) {
      lastError = error as Error;
      if (error instanceof HttpAnswerError) {
        throw error;
      }
      if (attempt < attempts) {
        await sleep(delayMs + Math.floor(Math.random() * delayMs));
      }
    }
  }
  throw new Error(`${url} did not answer after ${attempts} attempt(s): ${lastError?.message ?? 'no reason reported'}`);
}
