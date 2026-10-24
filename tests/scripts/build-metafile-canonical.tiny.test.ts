import { test, expect } from 'bun:test';
import { canonicalBuildMetafile, projectBuildMetafile } from '../../packages/xpod-cli/src/build-metafile';
test('producer canonicalizes object order while preserving all values and array order', () => {
 const a = Buffer.from('{"outputs":{"out":{"imports":[{"path":"b"},{"path":"a"}]}},"inputs":{"z":{"bytes":2},"a":{"bytes":1}}}');
 const b = Buffer.from('{"inputs":{"a":{"bytes":1},"z":{"bytes":2}},"outputs":{"out":{"imports":[{"path":"b"},{"path":"a"}]}}}');
 expect(canonicalBuildMetafile(a).equals(canonicalBuildMetafile(b))).toBe(true);
 expect(JSON.parse(canonicalBuildMetafile(a).toString())).toEqual(JSON.parse(a.toString()));
 expect(canonicalBuildMetafile(canonicalBuildMetafile(a)).equals(canonicalBuildMetafile(a))).toBe(true);
 expect(a.toString().startsWith('{"outputs"')).toBe(true);
});
test('complete metadata and exact UTF-8 required; special keys preserved', () => {
 for(const raw of [Buffer.from('{}'), Buffer.from('{"inputs":[],"outputs":{}}'), Buffer.from([255]), Buffer.from('{"inputs":{},"outputs":{},"invalid":1e400}')]) expect(() => canonicalBuildMetafile(raw)).toThrow();
 const raw=Buffer.from('{"inputs":{"__proto__":{"bytes":0}},"outputs":{}}');
 expect(Object.keys(JSON.parse(canonicalBuildMetafile(raw).toString()).inputs)).toEqual(['__proto__']);
});

const bindingsFor = (root: string) => [
 { physicalPath: `${root}/src/a.ts`, logicalPath: 'src/a.ts' },
 { physicalPath: `${root}/src/b.ts`, logicalPath: 'src/b.ts' },
 { physicalPath: `${root}/dist/out.js`, logicalPath: 'dist/out.js' },
];
const rawFor = (root: string) => Buffer.from(JSON.stringify({
 inputs: {
  [`${root}/src/a.ts`]: { bytes: 10, imports: [{ path: `${root}/src/b.ts`, kind: 'import' }] },
  [`${root}/src/b.ts`]: { bytes: 5 },
 },
 outputs: {
  [`${root}/dist/out.js`]: {
   bytes: 20,
   entryPoint: `${root}/src/a.ts`,
   imports: [{ path: `${root}/src/b.ts`, external: false }],
   inputs: { [`${root}/src/a.ts`]: { bytesInOutput: 7 } },
  },
 },
}));

test('two distinct physical roots project to the same logical metafile with exact bytes', () => {
 const physicalA = '/build/root-a';
 const physicalB = '/build/root-b';
 const expectedValue = {
  inputs: {
   'src/a.ts': { bytes: 10, imports: [{ kind: 'import', path: 'src/b.ts' }] },
   'src/b.ts': { bytes: 5 },
  },
  outputs: {
   'dist/out.js': {
    bytes: 20,
    entryPoint: 'src/a.ts',
    imports: [{ external: false, path: 'src/b.ts' }],
    inputs: { 'src/a.ts': { bytesInOutput: 7 } },
   },
  },
 };
 const expected = Buffer.from(JSON.stringify(expectedValue, null, 2) + '\n');
 const fromA = projectBuildMetafile(rawFor(physicalA), bindingsFor(physicalA));
 const fromB = projectBuildMetafile(rawFor(physicalB), bindingsFor(physicalB));
 expect(fromA.equals(fromB)).toBe(true);
 expect(fromA.equals(expected)).toBe(true);
 expect(JSON.parse(fromA.toString())).toEqual(expectedValue);
});

test('projection preserves unrelated strings, fields and array order', () => {
 const root = '/p';
 const raw = Buffer.from(JSON.stringify({
  inputs: {
   [`${root}/src/a.ts`]: {
    bytes: 1,
    sourceMap: `${root}/src/a.ts`,
    imports: [{ path: `${root}/src/b.ts` }, { path: `${root}/src/a.ts` }],
   },
   [`${root}/src/b.ts`]: { bytes: 2 },
  },
  outputs: {
   [`${root}/dist/out.js`]: {
    note: `${root}/src/a.ts`,
    entryPoint: `${root}/src/a.ts`,
    imports: [{ path: `${root}/src/b.ts` }, { path: `${root}/src/a.ts` }],
    inputs: {
     [`${root}/src/a.ts`]: { bytesInOutput: 3 },
     [`${root}/src/b.ts`]: { bytesInOutput: 4 },
    },
   },
  },
  extra: [`${root}/src/b.ts`, 'keep', { path: `${root}/src/a.ts` }],
 }));
 const bindings = [
  { physicalPath: `${root}/src/a.ts`, logicalPath: 'src/a.ts' },
  { physicalPath: `${root}/src/b.ts`, logicalPath: 'src/b.ts' },
  { physicalPath: `${root}/dist/out.js`, logicalPath: 'dist/out.js' },
 ];
 const projected = JSON.parse(projectBuildMetafile(raw, bindings).toString());
 const input = projected.inputs['src/a.ts'];
 expect(Object.keys(projected.inputs)).toEqual(['src/a.ts', 'src/b.ts']);
 expect(input.sourceMap).toBe(`${root}/src/a.ts`);
 expect(input.bytes).toBe(1);
 expect(input.imports.map((entry: { path: string }) => entry.path)).toEqual(['src/b.ts', 'src/a.ts']);
 const output = projected.outputs['dist/out.js'];
 expect(output.note).toBe(`${root}/src/a.ts`);
 expect(output.entryPoint).toBe('src/a.ts');
 expect(output.imports.map((entry: { path: string }) => entry.path)).toEqual(['src/b.ts', 'src/a.ts']);
 expect(Object.keys(output.inputs)).toEqual(['src/a.ts', 'src/b.ts']);
 expect(output.inputs['src/b.ts']).toEqual({ bytesInOutput: 4 });
 expect(projected.extra).toEqual([`${root}/src/b.ts`, 'keep', { path: `${root}/src/a.ts` }]);
});

test('mapping collisions with existing unmapped keys are rejected', () => {
 const bindings = [{ physicalPath: '/p/a', logicalPath: 'src/b.ts' }];
 const inputCollision = Buffer.from('{"inputs":{"/p/a":{"bytes":1},"src/b.ts":{"bytes":2}},"outputs":{}}');
 expect(() => projectBuildMetafile(inputCollision, bindings)).toThrow(/collides/);
 const outputCollision = Buffer.from('{"inputs":{},"outputs":{"/p/a":{"bytes":1},"src/b.ts":{"bytes":2}}}');
 expect(() => projectBuildMetafile(outputCollision, bindings)).toThrow(/collides/);
 const nestedCollision = Buffer.from('{"inputs":{},"outputs":{"/p/out.js":{"inputs":{"/p/a":{},"src/b.ts":{}}}}}');
 expect(() => projectBuildMetafile(nestedCollision, bindings)).toThrow(/collides/);
});

test('invalid bindings are rejected', () => {
 const raw = Buffer.from('{"inputs":{},"outputs":{}}');
 const logicalPaths = ['', '/absolute.ts', 'a/../b.ts', '../up.ts', 'a\\b.ts', 'a//b.ts', 'a/', '.', '..', 'a\u0000b', 'a\nb'];
 for (const logicalPath of logicalPaths) {
  expect(() => projectBuildMetafile(raw, [{ physicalPath: '/p/a', logicalPath }])).toThrow(/logicalPath/);
 }
 expect(() => projectBuildMetafile(raw, [{ physicalPath: '', logicalPath: 'a.ts' }])).toThrow(/physicalPath/);
 expect(() => projectBuildMetafile(raw, [
  { physicalPath: '/p/a', logicalPath: 'a.ts' },
  { physicalPath: '/p/a', logicalPath: 'b.ts' },
 ])).toThrow(/physicalPath/);
 expect(() => projectBuildMetafile(raw, [
  { physicalPath: '/p/a', logicalPath: 'a.ts' },
  { physicalPath: '/p/b', logicalPath: 'a.ts' },
 ])).toThrow(/logicalPath/);
});
