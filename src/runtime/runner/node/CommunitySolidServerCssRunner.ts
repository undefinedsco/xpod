import path from 'node:path';
import fs from 'node:fs';
import type { App } from '@solid/community-server';
import { ModuleStateBuilder, type IModuleState } from 'componentsjs';
import {
  ensureBunCommunitySolidServerJwkCompat,
  ensureBunUndiciCompat,
} from '../../compat/ensureBunUndiciCompat';
import type { CssRuntimeRunner, CssRuntimeRunnerStartOptions } from '../types';

export async function createPackageRootPreferredModuleState(packageRoot: string): Promise<IModuleState> {
  const moduleState = await new ModuleStateBuilder().buildModuleState(require, packageRoot);
  preferMainPackageComponents(moduleState);
  return moduleState;
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
    ensureBunUndiciCompat(options.packageRoot);
    const moduleState = await createPackageRootPreferredModuleState(options.packageRoot);
    const communitySolidServer = await import('@solid/community-server');
    ensureBunCommunitySolidServerJwkCompat(communitySolidServer);
    const { AppRunner } = communitySolidServer;
    const runner = new AppRunner();
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
