import { NotFoundHttpError, StaticAssetHandler } from '@solid/community-server';
import type { HttpHandlerInput } from '@solid/community-server';
import { readFileSync } from 'node:fs';
import { finished } from 'node:stream/promises';
import { lookup } from 'mime-types';
import path from 'path';
import { PACKAGE_ROOT } from '../runtime';

/**
 * A specialized StaticAssetHandler that serves the React UI assets
 * from the 'static/app' directory under the '/app/' URL path.
 */
export class AppStaticAssetHandler extends StaticAssetHandler {
  private readonly assetsPath: string;

  constructor() {
    const assetsPath = path.join(PACKAGE_ROOT, 'static/app/');
    console.log('AppStaticAssetHandler initialized!');
    console.log('Serving /app/ from:', assetsPath);
    
    super(
      [
        {
          relativeUrl: '/app/',
          filePath: assetsPath
        }
      ],
      'http://xpod.local/' 
    );
    this.assetsPath = assetsPath;
  }

  override async handle(input: HttpHandlerInput): Promise<void> {
    const pathname = new URL(input.request.url ?? '/', 'http://xpod.local').pathname;
    const relativePath = decodeURIComponent(pathname.slice('/app/'.length));
    const filePath = path.resolve(this.assetsPath, relativePath);
    const relativeToAssets = path.relative(this.assetsPath, filePath);
    if (!relativePath || relativeToAssets.startsWith('..') || path.isAbsolute(relativeToAssets)) {
      throw new NotFoundHttpError(`Cannot find ${input.request.url}`);
    }

    let content: Buffer;
    try {
      // These immutable, bundled files are small. Reading them synchronously
      // keeps the login shell independent from libuv's shared filesystem pool,
      // which can be occupied by concurrent identity/crypto work during an
      // Account navigation and otherwise leave a module request pending.
      content = readFileSync(filePath);
    } catch {
      throw new NotFoundHttpError(`Cannot find ${input.request.url}`);
    }

    input.response.writeHead(200, {
      'content-type': lookup(filePath) || 'application/octet-stream',
      'content-length': content.byteLength,
    });
    input.response.end(input.request.method === 'HEAD' ? undefined : content);
    if (!input.response.writableFinished) {
      await finished(input.response);
    }
  }
}
