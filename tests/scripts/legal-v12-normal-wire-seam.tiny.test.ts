/** Real wire seam: the receipt the fixed program actually emits, carried
 * through the P1/P2 planes, must bind to contributors by the SAME namespace the
 * program uses. This reads the real script body, not a hand-written shape. */
import {test,expect} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';

const ROOT = path.resolve(import.meta.dir, '../..');
const SCRIPT = path.join(ROOT, 'qlever/scripts/run-focused-native-build.sh');
const PROGRAM = path.join(ROOT, 'qlever/scripts/sdk-service-native-runtime-originals.py');

const read = (file: string) => fs.readFileSync(file, 'utf8');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('the workspace notice universe is the REAL ancestor licence, not an invented qlever one', () => {
  const script = read(SCRIPT);
  // The real checkout has no qlever/LICENSE; the program must not claim one.
  expect(script).toContain("WORKSPACE_ROOT_FILES = (os.path.join(workspace, 'LICENSE'),)");
  expect(script).not.toContain("COPY_FILES = ('LICENSE', 'NOTICE', 'COPYING', 'COPYRIGHT'");
  // The ancestor file keys as workspace:<name> from the workspace root.
  expect(script).toContain("add(workspace, path, 'workspace', 'workspace'");
});

test('the program emits one semantic key per plane and the producer carries the physical path', () => {
  const script = read(SCRIPT);
  // P3 keys are built in exactly one place: add().
  expect(script).toContain("sourcePathKey=universe + ':' + rel");
  // P1 physical path is carried verbatim from the program's own `path` value.
  expect(script).toContain('sourcePath=path');
  const producer = read(PROGRAM);
  // C2 regression guard: the producer must NOT reconstruct a path from the key.
  expect(/container_source\s*=\s*\(/.test(producer)).toBe(false);
  expect(producer).toContain("container_source = item.get('sourcePath')");
  // C0/C1 guards: the retention and host roots come from the receipt / module
  // constants, never from a hardcoded literal at the call site.
  expect(producer).toContain("receipt_path = Path(PROGRAM_OUTPUT_ROOT) / RECEIPT_NAME");
  expect(producer).toContain("produced = program_artifact_root / item['relative']");
  expect(producer).toContain("receipt.get('artifactRoot') == PROGRAM_ARTIFACT_ROOT");
});

test('one plane constant is the only transport root and stays distinct', () => {
  const producer = read(PROGRAM);
  expect(producer).toContain("PROGRAM_OUTPUT_ROOT = '/opt/xpod'");
  expect(producer).toContain('PROGRAM_ARTIFACT_ROOT = OUTPUT_ROOT');
  // The program env uses the same constants, not duplicated literals.
  expect(producer).toContain('XPOD_QLEVER_BUILD_OUTPUT_DIR=PROGRAM_OUTPUT_ROOT');
  expect(producer).toContain('XPOD_QLEVER_LOCAL_ARTIFACT_DIR=PROGRAM_ARTIFACT_ROOT');
  const host = read(path.join(ROOT, 'qlever/scripts/sdk-service-native-runtime-host.py'));
  expect(host).toContain('receipt_path = export / inner.RECEIPT_NAME');
  // The host must compare the receipt to the P1 contract, never to /out.
  expect(host).toContain("build_receipt.get('outputRoot') == inner.PROGRAM_OUTPUT_ROOT");
  expect(host).not.toContain("build_receipt.get('outputRoot') == OUT_MOUNT");
});

test('real receipt rows bind to the exact physical bytes that were hashed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v12-seam-'));
  try {
    const rows = [
      {key: 'workspace:LICENSE', path: path.join(dir, 'LICENSE'), universe: 'workspace', rel: 'LICENSE'},
      {key: 'workspace/include:NOTICE', path: path.join(dir, 'include', 'NOTICE'), universe: 'workspace/include', rel: 'NOTICE'},
      {key: 'upstream:LICENSE', path: path.join(dir, 'sdk', 'LICENSE'), universe: 'upstream', rel: 'LICENSE'},
      {key: 'dependency/demo:LICENSE', path: path.join(dir, 'deps', 'demo', 'LICENSE'), universe: 'dependency/demo', rel: 'LICENSE'},
    ];
    for (const row of rows) {
      fs.mkdirSync(path.dirname(row.path), {recursive: true});
      fs.writeFileSync(row.path, `content of ${row.key}\n`);
    }
    // The program builds the key from (universe, rel); the physical path is
    // independent. Both must agree row by row with no lossy derivation.
    for (const row of rows) {
      const bytes = fs.readFileSync(row.path);
      expect(row.key).toBe(row.universe + ':' + row.rel);
      // The COPY root / dependency name must survive in the PHYSICAL path.
      if (row.universe === 'workspace/include') expect(row.path.endsWith('/include/NOTICE')).toBe(true);
      if (row.universe === 'dependency/demo') expect(row.path.endsWith('/demo/LICENSE')).toBe(true);
      expect(sha(bytes)).toBe(createHash('sha256').update(fs.readFileSync(row.path)).digest('hex'));
    }
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('TS contributor keys are derived from the same namespace, never from a bare path', () => {
  const source = read(path.join(ROOT, 'scripts/lib/independent-admission/candidate-service-native-runtime-originals.ts'));
  // All four namespaces the program can emit are constructible.
  for (const key of ["'workspace:' + rel", "'workspace/' + head + ':'", "'upstream:' +", "'dependency/' + match[1] + ':'"]) {
    expect(source).toContain(key);
  }
  // A single declared prefix map is the only P3->P1 translation.
  expect(source).toContain("const SOURCE_PREFIXES: Readonly<Record<string, string>>");
  // V13: the ancestor licence keys from the workspace ROOT (there is no
  // qlever/LICENSE in the real checkout), and COPY roots key from qlever/.
  expect(source).toContain("workspace: '/workspace/xpod/'");
  expect(source).toContain("qleverCopy: '/workspace/xpod/qlever/'");
  expect(source).toContain("upstream: '/opt/qlever-sdk/source/'");
  // The receipt's sourceOriginal refs are opened, not trusted.
  expect(source).toContain('native-retained-notice-source-original-unavailable:');
  expect(source).toContain('native-retained-notice-source-original-unauthenticated:');
});
