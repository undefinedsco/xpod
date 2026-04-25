import { ProxyAgent } from 'undici';

function createProxyFetch(proxyUrl: string): typeof fetch {
  const agent = new ProxyAgent(proxyUrl);
  return (url, init) => fetch(url, { ...init, dispatcher: agent } as any);
}

export class ProviderHttpTransport {
  public async postJson(options: {
    url: string;
    apiKey: string;
    body: any;
    proxy?: string;
    headers?: HeadersInit;
  }): Promise<any> {
    const fetchFn = options.proxy ? createProxyFetch(options.proxy) : fetch;
    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('Authorization', `Bearer ${options.apiKey}`);

    const response = await fetchFn(options.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(options.body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`Provider error: ${response.statusText}`);
      (error as any).status = response.status;
      (error as any).headers = response.headers;
      (error as any).body = errorText;
      throw error;
    }

    return response.json();
  }

  public async postStream(options: {
    url: string;
    apiKey: string;
    body: any;
    proxy?: string;
    headers?: HeadersInit;
  }): Promise<Response> {
    const fetchFn = options.proxy ? createProxyFetch(options.proxy) : fetch;
    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('Authorization', `Bearer ${options.apiKey}`);

    const response = await fetchFn(options.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(options.body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`Provider error: ${response.statusText}`);
      (error as any).status = response.status;
      (error as any).headers = response.headers;
      (error as any).body = errorText;
      throw error;
    }

    return response;
  }
}
