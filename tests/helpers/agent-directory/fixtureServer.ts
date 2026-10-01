import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { ForbiddenHttpError, NotFoundHttpError, RepresentationMetadata } from '@solid/community-server';
import type { ResourceIdentifier } from '@solid/community-server';
import { AgentDirectoryHttpHandler } from '../../../src/http/agent-directory/AgentDirectoryHttpHandler';

const CONTENT_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.ttl': 'internal/quads',
};

interface FixtureAccessorOptions {
  fixtureDir: string;
  basePath: string;
  injectChildren?: (containerUrl: string) => string[];
  failChildrenFor?: string;
}

class FixtureAccessor {
  private readonly fixtureDir: string;
  private readonly basePath: string;
  private readonly injectChildren?: (containerUrl: string) => string[];
  private readonly failChildrenFor?: string;

  public constructor(options: FixtureAccessorOptions) {
    this.fixtureDir = options.fixtureDir;
    this.basePath = options.basePath;
    this.injectChildren = options.injectChildren;
    this.failChildrenFor = options.failChildrenFor;
  }

  private resolve(identifier: ResourceIdentifier): { filePath: string; relative: string } {
    const url = new URL(identifier.path);
    const relative = decodeURIComponent(url.pathname.slice(this.basePath.length)).replace(/^\/+/, '');
    if (relative.includes('..')) {
      throw new ForbiddenHttpError('path traversal');
    }
    return { filePath: path.join(this.fixtureDir, relative), relative };
  }

  public async getMetadata(identifier: ResourceIdentifier): Promise<RepresentationMetadata> {
    const { filePath } = this.resolve(identifier);
    let stats;
    try {
      stats = statSync(filePath);
    } catch {
      throw new NotFoundHttpError();
    }
    if (stats.isDirectory()) {
      return new RepresentationMetadata(identifier, 'internal/quads');
    }
    const metadata = new RepresentationMetadata(identifier);
    metadata.contentType = CONTENT_TYPES[path.extname(filePath)] ?? 'text/plain';
    metadata.contentLength = stats.size;
    return metadata;
  }

  public async *getChildren(identifier: ResourceIdentifier): AsyncIterableIterator<RepresentationMetadata> {
    if (this.failChildrenFor && identifier.path.endsWith(this.failChildrenFor)) {
      throw new NotFoundHttpError();
    }
    const { filePath } = this.resolve(identifier);
    for (const name of readdirSync(filePath)) {
      const childPath = new URL(encodeURIComponent(name), identifier.path.endsWith('/') ? identifier.path : `${identifier.path}/`);
      const childStats = statSync(path.join(filePath, name));
      yield new RepresentationMetadata({ path: `${childPath.href}${childStats.isDirectory() ? '/' : ''}` });
    }
    for (const injected of this.injectChildren?.(identifier.path) ?? []) {
      yield new RepresentationMetadata({ path: injected });
    }
  }

  public async getData(identifier: ResourceIdentifier): Promise<Readable> {
    const { filePath } = this.resolve(identifier);
    return Readable.from(readFileSync(filePath));
  }

  public async getLocalRdfDocument(identifier: ResourceIdentifier): Promise<{ data: Readable; metadata: RepresentationMetadata }> {
    const { filePath } = this.resolve(identifier);
    return {
      data: Readable.from(readFileSync(filePath)),
      metadata: new RepresentationMetadata(identifier, 'text/turtle'),
    };
  }
}

export interface FixtureServerOptions {
  fixtureDir: string;
  deniedPaths?: string[];
  /** Extra child URIs to inject for a container, used to test scope validation. */
  injectChildren?: (containerUrl: string) => string[];
  /** Container URL whose enumeration should throw, used to test incompleteness. */
  failChildrenFor?: string;
}

export interface FixtureServer {
  origin: string;
  podRoot: string;
  close: () => Promise<void>;
}

export async function startFixtureServer(options: FixtureServerOptions): Promise<FixtureServer> {
  const denied = new Set((options.deniedPaths ?? []).map((entry) => entry.replace(/^\/+/, '')));

  const handler = new AgentDirectoryHttpHandler(
    new FixtureAccessor({
      fixtureDir: options.fixtureDir,
      basePath: '/pod/',
      injectChildren: options.injectChildren,
      failChildrenFor: options.failChildrenFor,
    }) as never,
    {
      handleSafe: async () => ({ agent: { webId: 'did:test:agent' } }),
    } as never,
    {
      handleSafe: async () => ({}),
    } as never,
    {
      handleSafe: async (input: { requestedModes: { keys: () => Iterable<ResourceIdentifier> } }) => {
        for (const identifier of input.requestedModes.keys()) {
          const relative = decodeURIComponent(new URL(identifier.path).pathname).replace(/^\/pod\//, '');
          if (denied.has(relative)) {
            throw new ForbiddenHttpError('denied by fixture');
          }
        }
      },
    } as never,
    {
      isAuxiliaryIdentifier: (identifier: ResourceIdentifier) =>
        identifier.path.endsWith('.acl') || identifier.path.endsWith('.meta'),
      usesOwnAuthorization: () => false,
      isRequiredInRoot: () => false,
      addMetadata: async () => undefined,
      validate: async () => undefined,
    } as never,
    {
      supportsIdentifier: () => true,
      getParentContainer: () => ({ path: 'http://localhost/' }),
      isRootContainer: () => false,
      contains: () => true,
    } as never,
  );

  const server: Server = createServer((request, response) => {
    void handler.handle({ request, response } as never);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    podRoot: `${origin}/pod/`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
