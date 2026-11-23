import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderHttpTransport } from '../../../src/api/service/provider-http-transport';

afterEach(() => { vi.useRealTimers(); });

function streamingTransport(chunks?: string[], options: { timeoutMs?: number; intervalMs?: number } = { timeoutMs: 30_000 }) {
  const cancel = vi.fn();
  const transport = new ProviderHttpTransport({
    timeoutMs: options.timeoutMs,
    resolver: async () => [{ address: '203.0.113.10' }],
    fetch: vi.fn(async (_url: unknown, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        const abort = () => controller.error(init?.signal?.reason);
        init?.signal?.addEventListener('abort', abort, { once: true });
        let index = 0;
        if (chunks) {
          const timer = setInterval(() => {
            controller.enqueue(new TextEncoder().encode(chunks[index++]));
            if (index === chunks.length) {
              clearInterval(timer);
              init?.signal?.removeEventListener('abort', abort);
              controller.close();
            }
          }, options.intervalMs ?? 10_000);
        } else {
          controller.enqueue(new TextEncoder().encode('data: first\n\n'));
        }
      },
      cancel,
    }), { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch,
  });
  return { transport, cancel };
}

describe('provider streaming timeouts', () => {
  it('allows minutes of first-token wait and reasoning pauses with no total generation deadline', async () => {
    vi.useFakeTimers();
    const { transport } = streamingTransport(Array(6).fill('data: thought\n\n'), { intervalMs: 120_000 });
    const result = (async () => {
      const events = [];
      for await (const event of transport.postSse({ url: 'https://provider.test/chat', body: {} })) events.push(event.data);
      return events;
    })();
    const settled = result.then((value) => ({ value }), (error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(725_000);
    expect(await settled).toEqual({ value: Array(6).fill('thought') });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses a five-minute default idle deadline rather than thirty seconds', async () => {
    vi.useFakeTimers();
    const { transport } = streamingTransport(undefined, {});
    const iterator = transport.postSse({ url: 'https://provider.test/chat', body: {} })[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.data).toBe('first');
    let finished = false;
    const result = iterator.next().then(() => { finished = true; }, (error: Error) => { finished = true; return error.message; });
    await vi.advanceTimersByTimeAsync(299_999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await result).toBe('provider_request_timeout');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps active SSE responses alive beyond the total timeout, including heartbeat-only traffic', async () => {
    vi.useFakeTimers();
    const { transport } = streamingTransport(['data: first\n\n', ': ping\n\n', ': ping\n\n', ': ping\n\n', ': ping\n\n', 'data: last\n\n']);
    const result = (async () => {
      const events = [];
      for await (const event of transport.postSse({ url: 'https://provider.test/chat', body: {} })) events.push(event.data);
      return events;
    })();
    const settled = result.then((value) => ({ value }), (error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(65_000);
    expect(await settled).toEqual({ value: ['first', 'last'] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps raw streaming responses alive beyond the total timeout', async () => {
    vi.useFakeTimers();
    const { transport } = streamingTransport(Array(6).fill('data: token\n\n'));
    const result = transport.postStream({ url: 'https://provider.test/chat', apiKey: 'fixture', body: {} })
      .then((response) => response.text());
    const settled = result.then((value) => ({ value }), (error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(65_000);
    expect(await settled).toEqual({ value: 'data: token\n\n'.repeat(6) });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still aborts a stalled SSE response after the idle timeout', async () => {
    vi.useFakeTimers();
    const { transport } = streamingTransport();
    const iterator = transport.postSse({ url: 'https://provider.test/chat', body: {} })[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.data).toBe('first');
    const assertion = expect(iterator.next()).rejects.toThrow('provider_request_timeout');
    await vi.advanceTimersByTimeAsync(30_001);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves caller cancellation and releases raw stream timers', async () => {
    vi.useFakeTimers();
    const { transport } = streamingTransport();
    const abort = new AbortController();
    const response = await transport.postStream({ url: 'https://provider.test/chat', apiKey: 'fixture', body: {}, signal: abort.signal });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    abort.abort(new Error('caller_cancelled'));
    await expect(reader.read()).rejects.toThrow('caller_cancelled');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the upstream body when an SSE consumer stops early', async () => {
    vi.useFakeTimers();
    const { transport, cancel } = streamingTransport();
    for await (const event of transport.postSse({ url: 'https://provider.test/chat', body: {} })) {
      expect(event.data).toBe('first');
      break;
    }
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
