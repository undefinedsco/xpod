import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ts from 'typescript';
import { buildWithBun } from '../scripts/bun-build-api';
import { apiTestRepoRoot } from './repo-root';

/** Bundle real code while retaining imported modules' original file coordinates.
 * Only the pack entry keeps the fixture's actual repository geometry. */
export async function writeApiPackFixture(root: string): Promise<string> {
  const tool = await buildWithBun({
    entrypoints: [path.join(apiTestRepoRoot, 'packages/xpod-api/scripts/pack.ts')], target: 'node', format: 'esm',
    plugins: [{ name: 'actual-module-owner-fixture', setup(build) {
      build.onLoad({ filter: /\.[cm]?tsx?$/u }, (args) => {
        const source = readFileSync(args.path, 'utf8');
        const tree = ts.createSourceFile(args.path, source, ts.ScriptTarget.Latest, true);
        const replacements: Array<{ start: number; end: number }> = [];
        const visit = (node: ts.Node): void => {
          if (args.path !== path.join(apiTestRepoRoot, 'packages/xpod-api/scripts/pack.ts')
            && ts.isPropertyAccessExpression(node) && node.name.text === 'url' && ts.isMetaProperty(node.expression)
            && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword && node.expression.name.text === 'meta') {
            replacements.push({ start: node.getStart(tree), end: node.end });
          }
          ts.forEachChild(node, visit);
        };
        visit(tree);
        let contents = source;
        for (const row of replacements.sort((a, b) => b.start - a.start)) {
          contents = contents.slice(0, row.start) + JSON.stringify(pathToFileURL(args.path).href) + contents.slice(row.end);
        }
        return { contents, loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts' };
      });
    } }],
  });
  assert(tool.success, String(tool.logs));
  const packageRoot = path.join(root, 'packages/xpod-api');
  mkdirSync(path.join(packageRoot, 'scripts'), { recursive: true });
  const filename = path.join(packageRoot, 'scripts', 'pack.mjs');
  writeFileSync(filename, await tool.outputs[0].text());
  return filename;
}
