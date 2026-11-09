import { copyFileSync, cpSync, existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** Bind public clients to one canonical source copy inside preview materials. */
export function stagePreviewClients(repoRoot: string, stage: string): void {
  const cli = path.join(stage, 'packages/xpod-cli/src');
  const afs = path.join(cli, 'afs-client');
  const sdk = path.join(cli, 'runtime-client');
  cpSync(path.join(repoRoot, 'packages/xpod-afs/src'), afs, { recursive: true });
  cpSync(path.join(repoRoot, 'packages/xpod-client/src'), sdk, { recursive: true });
  const manifest = readFileSync(path.join(repoRoot, 'packages/xpod-client/package.json'), 'utf8');
  copyFileSync(path.join(repoRoot, 'packages/xpod-client/package.json'), path.join(sdk, 'package.json'));
  const entries = new Map<string, string>();
  for (const exported of Object.keys(JSON.parse(manifest).exports)) {
    if (exported !== '.' && !/^\.\/[a-z0-9/_-]+$/iu.test(exported)) throw new Error('Unsupported preview client export');
    const source = path.join(sdk, exported === '.' ? 'index' : exported.slice(2));
    const file = [source + '.ts', path.join(source, 'index.ts')].find(existsSync);
    if (!file || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) throw new Error('Preview client export source unavailable');
    entries.set('@undefineds.co/xpod-client' + (exported === '.' ? '' : exported.slice(1)), file);
  }
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name), stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('Preview client source symlink');
      if (stat.isDirectory()) { visit(file); continue; }
      if (!name.endsWith('.ts')) continue;
      const source = readFileSync(file, 'utf8');
      const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const edits: Array<{ start: number; end: number; value: string }> = [];
      const inspect = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node) && (
          (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) && node.parent.moduleSpecifier === node
          || ts.isCallExpression(node.parent) && node.parent.arguments[0] === node && (
            node.parent.expression.kind === ts.SyntaxKind.ImportKeyword
            || ts.isIdentifier(node.parent.expression) && node.parent.expression.text === 'require'))) {
          let target = entries.get(node.text);
          if ((node.text === '@undefineds.co/xpod-client' || node.text.startsWith('@undefineds.co/xpod-client/')) && !target) throw new Error('Unknown preview runtime client import');
          if (node.text === '@undefineds.co/xpod-cli/client') target = path.join(cli, 'client.ts');
          if (node.text === '@undefineds.co/xpod-cli/output') target = path.join(cli, 'lib/output.ts');
          if (node.text.startsWith('@undefineds.co/xpod-afs/')) target = path.join(afs, node.text.slice('@undefineds.co/xpod-afs/'.length));
          if (target) {
            let relative = path.relative(directory, target).split(path.sep).join('/');
            if (!relative.startsWith('.')) relative = './' + relative;
            edits.push({ start: node.getStart(syntax), end: node.end, value: JSON.stringify(relative) });
          }
        }
        ts.forEachChild(node, inspect);
      };
      inspect(syntax);
      let output = source;
      for (const edit of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.value + output.slice(edit.end);
      if (output !== source) writeFileSync(file, output);
    }
  };
  visit(path.join(stage, 'src'));
  visit(cli);
}
