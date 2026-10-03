import { describe, expect, it, vi } from 'vitest';
import { createTasksClient } from '../src/client';
describe('tasks transport', () => {
  it('keeps resource fragments in the encoded query and uses the supplied authenticated fetch', async () => {
    const fetch = vi.fn(async () => new Response('{"task":{}}', { status: 200 }));
    await createTasksClient({ fetch: fetch as typeof globalThis.fetch, baseUrl: 'https://pod.test/' }).update('index.ttl#mine', { completed: true });
    expect(fetch).toHaveBeenCalledWith('https://pod.test/api/tasks?id=index.ttl%23mine', expect.objectContaining({ method: 'PATCH', body: '{"completed":true}' }));
  });
  it('reports server failures without inventing success', async () => {
    const fetch = vi.fn(async () => new Response('{"error":"Pod unavailable"}', { status: 503 }));
    await expect(createTasksClient({ fetch: fetch as typeof globalThis.fetch }).list()).rejects.toThrow('任务服务暂时不可用，请稍后重试');
  });
});
