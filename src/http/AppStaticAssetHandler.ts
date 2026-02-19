import { StaticAssetHandler } from '@solid/community-server';
import path from 'path';
import { PACKAGE_ROOT } from '../runtime';

/**
 * A specialized StaticAssetHandler that serves the React UI assets
 * from the 'static/app' directory under the '/app/' URL path.
 */
export class AppStaticAssetHandler extends StaticAssetHandler {
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
  }
}
