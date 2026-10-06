import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '../..');

describe('single-binary logger sharing', () => {
  it('delivers custom component warnings through the factory initialized by CSS', async () => {
    const parent = path.join(root, '.test-data/bundle-logger');
    fs.mkdirSync(parent, { recursive: true });
    const stageRoot = fs.mkdtempSync(path.join(parent, 'case-'));
    try {
      // Load the real build functions without executing packaging or launching a service.
      const source = fs.readFileSync(path.join(root, 'scripts/build-bun-single.js'), 'utf8');
      const parsed = ts.createSourceFile('build.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const names = new Set(['bundlePackageMain', 'sharedDataFactoryPlugin', 'sharedLoggerFactoryPlugin']);
      const declarations = parsed.statements.filter((statement) =>
        ts.isFunctionDeclaration(statement) && statement.name && names.has(statement.name.text)
        || ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) =>
          ts.isIdentifier(declaration.name) && declaration.name.text === 'COMMON_BUNDLE_EXTERNALS'));
      const inertPlugin = { name: 'fixture-unused-plugin', setup() {} };
      const loadBuild = new Function('fs', 'path', 'esbuild', 'stageRoot', 'rootPackage',
        'createPackagePatchPlugin', 'extractedComponentsPlugin', 'kyUniversalBrowserPlugin',
        declarations.map((statement) => statement.getText(parsed)).join('\n') + '\nreturn bundlePackageMain;');
      const bundle = loadBuild(fs, path, esbuild, stageRoot, { name: '@undefineds.co/xpod' },
        () => inertPlugin, inertPlugin, inertPlugin) as (
        name: string, directory: string, metadata: { main: string }, destination: string,
      ) => Promise<string>;
      const loggerDirectory = path.dirname(require.resolve('global-logger-factory/package.json'));
      const loggerMetadata = JSON.parse(fs.readFileSync(path.join(loggerDirectory, 'package.json'), 'utf8'));
      await bundle('global-logger-factory', loggerDirectory, loggerMetadata,
        path.join(stageRoot, 'node_modules/global-logger-factory'));
      fs.writeFileSync(path.join(stageRoot, 'node_modules/global-logger-factory/package.json'),
        JSON.stringify({ main: 'dist/__bundle__.cjs' }));

      const fixtureRoot = path.join(stageRoot, 'fixture');
      fs.mkdirSync(fixtureRoot, { recursive: true });
      fs.writeFileSync(path.join(fixtureRoot, 'css.js'), `
        export { getLoggerFor, setGlobalLoggerFactory } from 'global-logger-factory';
      `);
      fs.mkdirSync(path.join(fixtureRoot, 'src'));
      fs.writeFileSync(path.join(fixtureRoot, 'src/index.ts'), `
        import { getLoggerFor } from 'global-logger-factory';
        export { getLoggerFor };
        export class AccountDiagnostic {
          logger = getLoggerFor(this);
          reject() { this.logger.warn('Host session Account authorization rejected: client_missing'); }
        }
      `);
      await bundle('@solid/community-server', fixtureRoot, { main: 'css.js' },
        path.join(stageRoot, 'node_modules/@solid/community-server'));
      await bundle('@undefineds.co/xpod', fixtureRoot, { main: 'unused' }, stageRoot);
      const css = require(path.join(stageRoot, 'node_modules/@solid/community-server/dist/__bundle__.cjs'));
      const custom = require(path.join(stageRoot, 'dist/__bundle__.cjs'));
      const messages: string[] = [];
      const component = new custom.AccountDiagnostic();
      css.setGlobalLoggerFactory({ createLogger: () => ({
        log(_level: string, message: string) { messages.push(message); return this; },
      }) });
      component.reject();

      expect(messages).toEqual(['Host session Account authorization rejected: client_missing']);
      expect(custom.getLoggerFor).toBe(css.getLoggerFor);
    } finally {
      fs.rmSync(stageRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
