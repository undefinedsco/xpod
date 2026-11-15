import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import original from '../fixtures/cli-metafile/actual-bun-1.4.2-import-gaps.json';
import { readPublicationMetafile } from '../../scripts/prepare-cli-publication';
const parse = (meta: any) => readPublicationMetafile(() => Buffer.from(JSON.stringify(meta)), 'fixture.json', false);
test('actual Bun dependency rows remain visible as six unverified gaps', () => {
  const result = parse(original);
  expect(result.dependencyImportGaps.length).toBe(6);
  expect(result.dependencyImportGaps.every((edge: any) => edge.reason === 'dependency-input-row-absent-unverified')).toBe(true);
});
test('a real output-contributing dependency input cannot be omitted', () => {
  const meta: any = structuredClone(original);
  const missing = '../../node_modules/uuid/dist/esm/validate.js';
  meta.outputs['./entry.mjs'] = { inputs: { [missing]: { bytesInOutput: 10 } } };
  expect(() => parse(meta)).toThrow('output-contributing');
});
test('cross-package and inconsistent dependency path substitutions still fail', () => {
  for (const edge of [
    { path: '../../node_modules/foreign/index.js', original: './missing.js' },
    { path: '../../node_modules/uuid/dist/esm/validate.js', original: './different.js' },
  ]) {
    const meta = { inputs: { '../../node_modules/uuid/dist/esm/stringify.js': { imports: [{ ...edge, kind: 'import-statement' }] } }, outputs: {} };
    expect(() => parse(meta)).toThrow('Omitted');
  }
});
test('unknown virtual runtime does not bypass missing input checks', () => {
  expect(() => parse({ inputs: { 'src/main.ts': { imports: [{ path: 'bun:unknown', kind: 'import-statement' }] } }, outputs: {} })).toThrow('Omitted');
});
test('micro real Bun build reproduces bun:wrap while deleted first-party inputs still fail', () => {
  const base = path.resolve('.test-data/cli-metafile-import-semantics'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'test-'));
  try {
    writeFileSync(path.join(root, 'entry.ts'), "import {answer} from './constant'; export {answer}; export const load = () => require(process.argv[2]);\n");
    writeFileSync(path.join(root, 'constant.ts'), 'export const answer = 42;\n');
    const result = spawnSync('bun', ['build', '--target=node', '--format=esm', '--metafile=meta.json', '--outfile=out.mjs', 'entry.ts'], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(0);
    const bytes = readFileSync(path.join(root, 'meta.json')), meta = JSON.parse(bytes.toString());
    expect(meta.inputs['entry.ts'].imports.some((edge: any) => edge.path === 'bun:wrap' && edge.external === undefined)).toBe(true);
    expect(parse(meta).dependencyImportGaps).toEqual([]);
    writeFileSync(path.join(base, 'micro-observation.json'), JSON.stringify({ bunVersion: process.versions.bun, metadataSha256: createHash('sha256').update(bytes).digest('hex'), metadata: meta }, null, 2));
    delete meta.inputs['constant.ts'];
    expect(() => parse(meta)).toThrow('Omitted canonical');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
