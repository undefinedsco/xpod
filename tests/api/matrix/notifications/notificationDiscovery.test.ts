import { describe, expect, it, vi } from 'vitest';
import { notificationEndpointOf } from '../../../../src/api/matrix/notifications/roomWatchService';

const pod = 'https://pod.example/alice/';
const relation = 'http://www.w3.org/ns/solid/terms#storageDescription';
const notify = 'http://www.w3.org/ns/solid/notifications#';
function discovery(endpoint = 'https://pod.example/.notifications/WebSocketChannel2023/', options: { noLink?: boolean; forbidden?: boolean; jsonld?: boolean; wrongType?: boolean } = {}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === pod) return new Response(null, { headers: options.noLink ? {} : { link: `<../.description>; rel="${relation}"` } });
    if (options.forbidden) return new Response(null, { status: 403 });
    const type = `${notify}${options.wrongType ? 'WebhookChannel2023' : 'WebSocketChannel2023'}`;
    if (options.jsonld) return new Response(JSON.stringify([
      { '@id': 'https://pod.example/.description', [`${notify}subscription`]: [ { '@id': endpoint } ] },
      { '@id': endpoint, [`${notify}channelType`]: [ { '@id': type } ] },
    ]), { headers: { 'content-type': 'application/ld+json' } });
    return new Response(`<https://pod.example/.description> <${notify}subscription> <${endpoint}>.
<${endpoint}> <${notify}channelType> <${type}>.`, { headers: { 'content-type': 'text/turtle' } });
  }) as unknown as typeof fetch;
}
describe('notification service discovery', () => {
  it('uses the advertised server-root endpoint for a nested Pod', async () => {
    const fetch = discovery();
    expect(await notificationEndpointOf(pod, fetch)).toBe('https://pod.example/.notifications/WebSocketChannel2023/');
    expect(fetch).toHaveBeenNthCalledWith(1, pod, expect.objectContaining({ method: 'HEAD' }));
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://pod.example/.description', expect.anything());
  });
  it('preserves an advertised deployment prefix and custom endpoint', async () => {
    expect(await notificationEndpointOf(pod, discovery('https://pod.example/mounted/custom/subscribe')))
      .toBe('https://pod.example/mounted/custom/subscribe');
  });
  it('reads an expanded JSON-LD service description', async () => {
    expect(await notificationEndpointOf(pod, discovery(undefined, { jsonld: true })))
      .toBe('https://pod.example/.notifications/WebSocketChannel2023/');
  });
  it.each([ { noLink: true }, { forbidden: true }, { wrongType: true } ])('refuses unavailable discovery without guessing (%j)', async options => {
    await expect(notificationEndpointOf(pod, discovery(undefined, options))).rejects.toThrow();
  });
});
