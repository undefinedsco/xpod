import { AsyncLocalStorage } from 'node:async_hooks';
import { ensureSupportedBun } from '../../compat/ensureSupportedBun';
import path from 'node:path';
import fs from 'node:fs';
import type { App, AppRunner, AppRunnerInput } from '@solid/community-server';
import { ModuleStateBuilder, type IModuleState, type IComponentsManagerBuilderOptions, type ComponentsManager } from 'componentsjs';
import {
  ensureBunCommunitySolidServerJwkCompat,
  ensureBunUndiciCompat,
} from '../../compat/ensureBunUndiciCompat';
import type { CssRuntimeRunner, CssRuntimeRunnerStartOptions } from '../types';

/** The compiled archive owns its complete Components.js dependency tree. */
class ExtractedPackageModuleStateBuilder extends ModuleStateBuilder {
  public override buildNodeModuleImportPaths(mainModulePath: string): string[] {
    return [mainModulePath];
  }
}

export interface CssModuleLoaderOptions { isolatedDependencies?: boolean }
interface AppCreationScope { active: boolean; getApp?: () => Promise<unknown> | undefined }

export async function createPackageRootPreferredModuleState(packageRoot: string, options: CssModuleLoaderOptions = {}): Promise<IModuleState> {
  const extracted = options.isolatedDependencies === true || process.env.XPOD_BUN_SINGLE_RUNTIME === '1';
  const builder = extracted ? new ExtractedPackageModuleStateBuilder() : new ModuleStateBuilder();
  const moduleState = await builder.buildModuleState(require, packageRoot);
  if (extracted && moduleState.nodeModulePaths.some(directory => {
    const relative = path.relative(moduleState.mainModulePath, directory);
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  })) {
    throw new Error('Extracted Components dependency is outside its packaged runtime');
  }
  preferMainPackageComponents(moduleState);
  return moduleState;
}

/** Keep CSS's CLI parsing and startup while supplying the extracted dependency state. */
export function createPackageRootPreferredAppRunner(Runner: typeof AppRunner, packageRoot: string, options: CssModuleLoaderOptions = {}): AppRunner {
  return new class extends Runner {
    private creating = false;
    private readonly creationScope = new AsyncLocalStorage<AppCreationScope>();

    public override async createComponentsManager<T>(loaderProperties: IComponentsManagerBuilderOptions<T>, configs: string[]): Promise<ComponentsManager<T>> {
      const manager = await super.createComponentsManager(loaderProperties, configs);
      const scope = this.creationScope.getStore();
      if (scope?.active) scope.getApp = () => manager.configConstructorPool.getInstanceRegistry()['urn:solid-server:default:App'];
      return manager;
    }

    public override async create(input: AppRunnerInput = {}): Promise<App> {
      if (this.creating) throw new Error('CSS App creation is already in progress for this runner');
      this.creating = true;
      const scope: AppCreationScope = { active: true };
      try {
        return await this.creationScope.run(scope, async(): Promise<App> => {
          try {
            if (options.isolatedDependencies || process.env.XPOD_BUN_SINGLE_RUNTIME === '1') {
              const moduleState = await createPackageRootPreferredModuleState(packageRoot, options);
              input = { ...input, loaderProperties: { ...input.loaderProperties, mainModulePath: packageRoot, moduleState } };
            }
            return await super.create(input);
          } catch (creationError: unknown) {
            // Upstream can reject thread safety after constructing App. Retain that
            // validation and finalize only the App belonging to this creation.
            let app: App | undefined;
            try { app = await scope.getApp?.() as App | undefined; }
            catch { throw creationError; } // Partial construction has no public rollback contract.
            if (app) {
              try { await app.stop(); }
              catch (cleanupError: unknown) {
                throw new AggregateError([creationError, cleanupError], 'CSS App creation and cleanup failed');
              }
            }
            throw creationError;
          }
        });
      } finally {
        scope.active = false;
        scope.getApp = undefined;
        this.creating = false;
      }
    }
  }();
}

function preferMainPackageComponents(moduleState: IModuleState): void {
  const packageRoot = moduleState.mainModulePath;
  const packageJson = moduleState.packageJsons[packageRoot];
  const moduleIri = packageJson?.['lsd:module'];
  const version = packageJson?.version;
  if (typeof moduleIri !== 'string' || typeof version !== 'string') {
    return;
  }

  const major = Number.parseInt(version.split('.')[0], 10);
  if (!Number.isFinite(major)) {
    return;
  }

  const componentsPath = packageJson['lsd:components'];
  if (typeof componentsPath === 'string') {
    moduleState.componentModules[moduleIri] ??= {};
    moduleState.componentModules[moduleIri][major] = path.posix.join(packageRoot, componentsPath);
  }

  const contexts = packageJson['lsd:contexts'];
  if (isStringRecord(contexts)) {
    for (const [contextIri, contextPath] of Object.entries(contexts)) {
      moduleState.contexts[contextIri] = JSON.parse(fs.readFileSync(path.posix.join(packageRoot, contextPath), 'utf8'));
    }
  }

  const importPaths = packageJson['lsd:importPaths'];
  if (isStringRecord(importPaths)) {
    for (const [importIri, importPath] of Object.entries(importPaths)) {
      moduleState.importPaths[importIri] = path.posix.join(packageRoot, importPath);
    }
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string');
}

export class CommunitySolidServerCssRunner implements CssRuntimeRunner {
  public readonly name = 'community-solid-server';

  public async start(options: CssRuntimeRunnerStartOptions): Promise<App> {
    ensureSupportedBun();
    ensureBunUndiciCompat(options.packageRoot);
    const moduleState = await createPackageRootPreferredModuleState(options.packageRoot);
    const communitySolidServer = await import('@solid/community-server');
    ensureBunCommunitySolidServerJwkCompat(communitySolidServer);
    const { AppRunner } = communitySolidServer;
    const runner = createPackageRootPreferredAppRunner(AppRunner, options.packageRoot);
    const app = await runner.create({
      config: options.configPath,
      loaderProperties: {
        mainModulePath: options.packageRoot,
        moduleState,
        logLevel: options.logLevel as any,
      },
      shorthand: options.shorthand,
    });

    await app.start();
    return app;
  }
}

export const communitySolidServerCssRunner = new CommunitySolidServerCssRunner();
