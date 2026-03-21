import type { App } from '@solid/community-server';
import { ensureBunUndiciCompat } from '../../compat/ensureBunUndiciCompat';
import type { CssRuntimeRunner, CssRuntimeRunnerStartOptions } from '../types';

export class CommunitySolidServerCssRunner implements CssRuntimeRunner {
  public readonly name = 'community-solid-server';

  public async start(options: CssRuntimeRunnerStartOptions): Promise<App> {
    ensureBunUndiciCompat(options.packageRoot);
    const { AppRunner } = await import('@solid/community-server');
    const runner = new AppRunner();
    const app = await runner.create({
      config: options.configPath,
      loaderProperties: {
        mainModulePath: options.packageRoot,
        logLevel: options.logLevel as any,
      },
      shorthand: options.shorthand,
    });

    await app.start();
    return app;
  }
}

export const communitySolidServerCssRunner = new CommunitySolidServerCssRunner();
