import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { parseTypeScriptStaticHelperRecords, inspectTypeScriptHelperGrants } from '../../scripts/lib/independent-admission/legal-typescript-helpers';
import type { CollectedArtifactView, DerivedSourceView } from '../../scripts/lib/independent-admission/artifact-contract';
import { verifyApacheGrantText } from '../../scripts/lib/independent-admission/legal-admission';
const fixture = readFileSync(new URL('../fixtures/legal-originals/typescript-5.5.4.helpers.txt', import.meta.url), 'utf8');
test('actual TypeScript static helper texts are decoded with the emitter common indentation', () => {
  const templates = parseTypeScriptStaticHelperRecords(fixture);
  expect([...templates.keys()]).toEqual(['__createBinding', '__setModuleDefault', '__importStar', '__importDefault']);
  expect(templates.get('__importDefault')).toBe('var __importDefault = (this && this.__importDefault) || function (mod) {\n    return (mod && mod.__esModule) ? mod : { "default": mod };\n};');
});
test('dynamic, custom and non-TypeScript records cannot establish static helper identity', () => {
  expect(parseTypeScriptStaticHelperRecords(fixture.replace('text: `', 'text: makeHelper`')).size).toBe(3);
  expect(parseTypeScriptStaticHelperRecords('var unknownHelper = {\n name: "other:foo", text: `var __foo = (this && this.__foo) || function(){};`\n};').size).toBe(0);
  expect(() => parseTypeScriptStaticHelperRecords('x'.repeat(131073))).toThrow('window exceeded');
});
test('actual TypeScript Apache original retains all normative conditions without optional appendix', () => {
  const original = gunzipSync(readFileSync(new URL('../fixtures/legal-originals/typescript-5.5.4.LICENSE.txt.gz', import.meta.url)));
  expect(createHash('sha256').update(original).digest('hex')).toBe('a7d00bfd54525bc694b6e32f64c7ebcf5e6b7ae3657be5cc12767bce74654a47');
  const standard = readFileSync(new URL('../../packages/xpod-cli/licenses/native/collection/objects/cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30.txt', import.meta.url));
  expect(verifyApacheGrantText(original, standard, 'Apache-2.0')).toBe(true);
  expect(verifyApacheGrantText(Buffer.from(original.toString().replace('You must give any other recipients', 'You need not give any other recipients')), standard, 'Apache-2.0')).toBe(false);
  expect(verifyApacheGrantText(Buffer.concat([original, Buffer.from('\nNo commercial use.')]), standard, 'Apache-2.0')).toBe(false);
});
test('compiler metadata and fake capabilities never issue helper grant coverage', () => {
  expect(inspectTypeScriptHelperGrants({} as CollectedArtifactView, {} as DerivedSourceView, { sourceSha: 'a'.repeat(40), transpiledOutputs: [] }, [{ legalQualified: true }], () => true)).toEqual({ coveredOutputs: [], pending: [] });
});

test('real verifier-owned TypeScript emit matches original helper text, changed and unknown helper bodies fail', async () => {
  const ts = await import('typescript');
  const { verifyTypeScriptEmittedHelperTexts } = await import('../../scripts/lib/independent-admission/legal-typescript-helpers');
  const output = Buffer.from(ts.transpileModule('import value from "example"; export const x = value;', { compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText);
  const templates = parseTypeScriptStaticHelperRecords(fixture);
  const verify = (bytes: Buffer) => verifyTypeScriptEmittedHelperTexts(bytes.length, (offset, length) => bytes.subarray(offset, offset + length), templates);
  expect(verify(output)).toEqual([]);
  expect(verify(Buffer.from(output.toString().replace('mod && mod.__esModule', 'mod || mod.__esModule')))).toEqual(['__importDefault']);
  expect(verify(Buffer.from('var __unknownHelper = function() { return 1; };'))).toEqual(['__unknownHelper']);
  const prefixed = Buffer.concat([Buffer.alloc(65530, 32), Buffer.from('\n'), output]);
  expect(verify(prefixed)).toEqual([]);
});

test('complete compiler copy retains the original ThirdPartyNoticeText and rejects changed or omitted notice', async () => {
  const { verifyTypeScriptCompilerOriginalInventory } = await import('../../scripts/lib/independent-admission/legal-typescript-helpers');
  const rows = ['package.json', 'LICENSE.txt', 'ThirdPartyNoticeText.txt', 'lib/typescript.js'].map((path, i) => ({ path, bytes: i + 1, sha256: String(i).repeat(64), mode: 0o644 }));
  const members = rows.map(row => ({ ...row, path: 'provenance/compiler-originals/typescript/' + row.path }));
  expect(() => verifyTypeScriptCompilerOriginalInventory(rows, members, rows)).not.toThrow();
  expect(() => verifyTypeScriptCompilerOriginalInventory(rows.filter(row => row.path !== 'ThirdPartyNoticeText.txt'), members.filter(row => !row.path.endsWith('ThirdPartyNoticeText.txt')), rows)).toThrow('inventory is incomplete');
  expect(() => verifyTypeScriptCompilerOriginalInventory(rows, members.map(row => row.path.endsWith('ThirdPartyNoticeText.txt') ? { ...row, sha256: 'f'.repeat(64) } : row), rows)).toThrow('retained compiler original differs');
});
