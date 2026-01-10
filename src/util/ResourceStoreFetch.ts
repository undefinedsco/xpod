/**
 * ResourceStoreFetch - 将 ResourceStore 包装成 fetch 接口
 *
 * 用于在服务端内部访问 Pod 数据，绕过 HTTP 层和 DPoP 认证。
 * drizzle-solid 可以直接使用这个 fetch 函数。
 */

import { getLoggerFor } from 'global-logger-factory';
import type { ResourceStore } from '@solid/community-server';
import { BasicRepresentation, RepresentationMetadata } from '@solid/community-server';
import { Readable } from 'node:stream';

const logger = getLoggerFor('ResourceStoreFetch');

/**
 * 创建一个基于 ResourceStore 的 fetch 函数
 */
export function createResourceStoreFetch(resourceStore: ResourceStore): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method?.toUpperCase() ?? 'GET';

    logger.debug(`ResourceStoreFetch: ${method} ${url}`);

    try {
      if (method === 'GET' || method === 'HEAD') {
        return await handleGet(resourceStore, url, method === 'HEAD');
      }

      if (method === 'PUT') {
        return await handlePut(resourceStore, url, init);
      }

      if (method === 'DELETE') {
        return await handleDelete(resourceStore, url);
      }

      if (method === 'PATCH') {
        return await handlePatch(resourceStore, url, init);
      }

      // 不支持的方法
      return new Response(null, { status: 405, statusText: 'Method Not Allowed' });
    } catch (error: any) {
      logger.error(`ResourceStoreFetch error: ${error.message}`);

      // 处理常见错误
      if (error.statusCode === 404 || error.name === 'NotFoundHttpError') {
        return new Response(null, { status: 404, statusText: 'Not Found' });
      }

      if (error.statusCode === 401 || error.name === 'UnauthorizedHttpError') {
        return new Response(null, { status: 401, statusText: 'Unauthorized' });
      }

      if (error.statusCode === 403 || error.name === 'ForbiddenHttpError') {
        return new Response(null, { status: 403, statusText: 'Forbidden' });
      }

      return new Response(error.message, { status: 500, statusText: 'Internal Server Error' });
    }
  };
}

async function handleGet(resourceStore: ResourceStore, url: string, headOnly: boolean): Promise<Response> {
  const identifier = { path: url };
  const preferences = {
    type: { 'text/turtle': 1, 'application/ld+json': 0.9, '*/*': 0.1 },
  };

  const representation = await resourceStore.getRepresentation(identifier, preferences);
  const contentType = representation.metadata.contentType ?? 'application/octet-stream';

  if (headOnly) {
    // HEAD 请求，不返回 body
    representation.data.destroy();
    return new Response(null, {
      status: 200,
      headers: { 'Content-Type': contentType },
    });
  }

  // 将 Node.js Readable 流转换为 Web ReadableStream
  const webStream = Readable.toWeb(representation.data) as ReadableStream;

  return new Response(webStream, {
    status: 200,
    headers: { 'Content-Type': contentType },
  });
}

async function handlePut(resourceStore: ResourceStore, url: string, init?: RequestInit): Promise<Response> {
  const identifier = { path: url };
  const contentType = getContentType(init?.headers) ?? 'text/turtle';

  // 获取请求体
  const body = init?.body;
  let data: Readable;

  if (typeof body === 'string') {
    data = Readable.from([body]);
  } else if (body instanceof ArrayBuffer) {
    data = Readable.from([Buffer.from(new Uint8Array(body))]);
  } else if (body instanceof Uint8Array) {
    data = Readable.from([Buffer.from(body)]);
  } else if (body && typeof (body as any).getReader === 'function') {
    // Web ReadableStream
    data = Readable.fromWeb(body as ReadableStream);
  } else {
    data = Readable.from([]);
  }

  const metadata = new RepresentationMetadata({ path: url }, { 'content-type': contentType });
  const representation = new BasicRepresentation(data, metadata);

  await resourceStore.setRepresentation(identifier, representation);

  return new Response(null, { status: 201, statusText: 'Created' });
}

async function handleDelete(resourceStore: ResourceStore, url: string): Promise<Response> {
  const identifier = { path: url };
  await resourceStore.deleteResource(identifier);
  return new Response(null, { status: 204, statusText: 'No Content' });
}

async function handlePatch(resourceStore: ResourceStore, url: string, init?: RequestInit): Promise<Response> {
  const identifier = { path: url };
  const contentType = getContentType(init?.headers) ?? 'application/sparql-update';

  const body = init?.body;
  let data: Readable;

  if (typeof body === 'string') {
    data = Readable.from([body]);
  } else if (body && typeof (body as any).getReader === 'function') {
    data = Readable.fromWeb(body as ReadableStream);
  } else {
    data = Readable.from([]);
  }

  const metadata = new RepresentationMetadata({ path: url }, { 'content-type': contentType });
  const patch = new BasicRepresentation(data, metadata);

  await resourceStore.modifyResource(identifier, patch as any);

  return new Response(null, { status: 204, statusText: 'No Content' });
}

function getContentType(headers?: RequestInit['headers']): string | undefined {
  if (!headers) return undefined;

  if (headers instanceof Headers) {
    return headers.get('content-type') ?? undefined;
  }

  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === 'content-type');
    return found ? found[1] : undefined;
  }

  // Record<string, string>
  if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === 'content-type') {
        return typeof value === 'string' ? value : undefined;
      }
    }
  }

  return undefined;
}
