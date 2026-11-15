import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Header } from 'tar';
import { gzipSync } from 'node:zlib';
import {
  apiCapabilityPath,
  consumeApiCapability,
  prepareApiCapability,
} from '../scripts/api-capability-producer';

/**
 * Transport/extraction tests for the desktop API capability adapter.
 *
 * Real production needs a clean checkout, controlled Inngest original materials
 * and a matching native host (macOS15 CI). These tests instead drive the adapter's
 * transport with a REAL minimal `package/*` archive and an injected producer
 * runner, so every rejection below is exercised on actual bytes rather than on
 * source text.
 */

const repoRoot = path.resolve(import.meta.dir, '../..');
const owned: string[] = [];
afterAll(() => { for (const dir of owned) rmSync(dir, { recursive: true, force: true }); });

const HEAD = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();

/** A fresh canonical `<repo>/.test-data/api-capability-*` output path. */
function ownedOutput(): string {
  const dir = path.join(repoRoot, '.test-data',
    `api-capability-test-${process.pid}-${Math.random().toString(16).slice(2, 10)}`);
  owned.push(dir);
  return dir;
}

/** Build a REAL minimal module archive with `package/*` members inside `outDir`. */
function writeArchive(outDir: string, options: { version?: string; name?: string } = {}): string {
  const stage = path.join(outDir, 'stage-src');
  const pkg = path.join(stage, 'package');
  mkdirSync(pkg, { recursive: true });
  const entry = 'export const api = true;\n';
  writeFileSync(path.join(pkg, 'entry.mjs'), entry);
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
    name: options.name ?? `@undefineds.co/xpod-api-${process.platform}-${process.arch}`,
    version: options.version ?? '0.0.0-preview.1',
    xpodModule: {
      schemaVersion: 1, id: 'api', cliApiVersion: 1,
      platform: process.platform, arch: process.arch, entry: 'entry.mjs',
      files: [{ path: 'entry.mjs', sha256: createHash('sha256').update(entry).digest('hex'),
        size: Buffer.byteLength(entry), mode: 0o644 }],
    },
  }, null, 2) + '\n');
  const archive = path.join(outDir, 'product.tgz');
  const tar = spawnSync('tar', ['-czf', archive, '-C', stage, 'package'], { encoding: 'utf8' });
  expect(tar.status).toBe(0);
  return archive;
}

function writeReceipt(outDir: string, sourceSha: string, archive: string, overrides: Record<string, unknown> = {}): void {
  const bytes = readFileSync(archive);
  writeFileSync(path.join(outDir, 'producer.receipt.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'api-module-product-production',
    status: 'controlled-preview-materials',
    context: { kind: 'local-desktop-build', actualCheckoutSha: sourceSha },
    sourceBefore: { sha: sourceSha, status: '' },
    sourceAfter: { sha: sourceSha },
    archive: { path: path.relative(outDir, archive),
      sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length },
    ...overrides,
  }, null, 2) + '\n');
}

/** A producer runner that builds a real product inside the adapter's output dir. */
function runner(build: (outDir: string) => string, options: { tamperAfter?: boolean } = {}) {
  return (request: { output: string }) => {
    expect(existsSync(request.output)).toBe(false);
    const archive = build(request.output);
    writeReceipt(request.output, HEAD, archive);
    if (options.tamperAfter) {
      writeFileSync(archive, Buffer.concat([readFileSync(archive), Buffer.from('x')]));
    }
    return { status: 0, stdout: '{}' };
  };
}

describe('prepare/consume transport', () => {
  it('returns the unpacked package root, not a doubled package/package path', () => {
    const outputDir = ownedOutput();
    const result = prepareApiCapability({ repoRoot, outputDir,
      runProducer: runner(dir => writeArchive(dir, { version: '0.0.0-preview.9' })) });
    // The archive's own manifest is the version authority, not the caller.
    expect(result.version).toBe('0.0.0-preview.9');
    expect(result.packageRoot.endsWith(path.join('unpacked', 'package'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(result.packageRoot, 'package.json'), 'utf8')).xpodModule.id).toBe('api');
    expect(result.sourceSha).toBe(HEAD);
    expect(apiCapabilityPath(repoRoot, HEAD)).toBe(path.join(repoRoot, '.test-data', `api-capability-${HEAD}`));
  });

  it('rejects altered archive bytes against the recorded digest', () => {
    const outputDir = ownedOutput();
    expect(() => prepareApiCapability({ repoRoot, outputDir,
      runProducer: runner(dir => writeArchive(dir), { tamperAfter: true }) }))
      .toThrow(/differs from its receipt|differ from the receipt/);
  });

  it('rejects a failed producer status instead of trusting the receipt', () => {
    const outputDir = ownedOutput();
    expect(() => prepareApiCapability({ repoRoot, outputDir,
      runProducer: () => ({ status: 1, stdout: '', stderr: 'phase failed' }) })).toThrow(/production failed/);
  });

  it('rejects a receipt whose status is not a successful preview', () => {
    const outputDir = ownedOutput();
    const run = (request: { output: string }) => {
      const archive = writeArchive(request.output);
      writeReceipt(request.output, HEAD, archive, { status: 'failed' });
      return { status: 0, stdout: '{}' };
    };
    expect(() => prepareApiCapability({ repoRoot, outputDir, runProducer: run }))
      .toThrow(/not a successful controlled-preview/);
  });

  it('rejects a receipt bound to a different source SHA', () => {
    const outputDir = ownedOutput();
    const run = (request: { output: string }) => {
      const archive = writeArchive(request.output);
      writeReceipt(request.output, 'f'.repeat(40), archive);
      return { status: 0, stdout: '{}' };
    };
    expect(() => prepareApiCapability({ repoRoot, outputDir, runProducer: run })).toThrow(/different source/);
  });

  it('rejects an archive path that escapes the owned output', () => {
    const outputDir = ownedOutput();
    const outside = ownedOutput();
    mkdirSync(outside, { recursive: true });
    const archive = writeArchive(outside);
    const bytes = readFileSync(archive);
    const run = (request: { output: string }) => {
      mkdirSync(request.output, { recursive: true });
      writeReceipt(request.output, HEAD, archive, {
        archive: { path: '../../escape.tgz',
          sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length },
      });
      return { status: 0, stdout: '{}' };
    };
    expect(() => prepareApiCapability({ repoRoot, outputDir, runProducer: run })).toThrow(/escapes the owned output/);
  });

  it('rejects an archive that is not the exact api module identity', () => {
    const outputDir = ownedOutput();
    expect(() => prepareApiCapability({ repoRoot, outputDir,
      runProducer: runner(dir => writeArchive(dir, { name: '@undefineds.co/xpod-css-darwin-arm64' })) }))
      .toThrow(/not the api module/);
  });

  it('consume never re-runs the producer and still verifies the product', () => {
    const outputDir = ownedOutput();
    prepareApiCapability({ repoRoot, outputDir,
      runProducer: runner(dir => writeArchive(dir, { version: '0.0.0-preview.11' })) });
    const consumed = consumeApiCapability({ repoRoot, outputDir, expectedSourceSha: HEAD });
    expect(consumed.version).toBe('0.0.0-preview.11');
    expect(consumed.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
    const entry = path.join(consumed.packageRoot, 'entry.mjs');
    writeFileSync(entry, 'changed decoded cache');
    const restored = consumeApiCapability({ repoRoot, outputDir });
    expect(readFileSync(path.join(restored.packageRoot, 'entry.mjs'), 'utf8')).toBe('export const api = true;\n');
    expect(() => consumeApiCapability({ repoRoot, outputDir, expectedSourceSha: 'f'.repeat(40) }))
      .toThrow(/differs from the actual checkout/);
    // A tampered archive is caught on consume too.
    writeFileSync(consumed.archive, Buffer.concat([readFileSync(consumed.archive), Buffer.from('y')]));
    expect(() => consumeApiCapability({ repoRoot, outputDir, expectedSourceSha: HEAD }))
      .toThrow(/differs from its receipt|differ from the receipt/);
  });

  it('rejects traversal and duplicate archive members before extracting any files', () => {
    for (const names of [['package/../../escaped.txt'], ['package/entry.mjs', 'package/entry.mjs']]) {
      const outputDir = ownedOutput();
      const run = (request: { output: string }) => {
        mkdirSync(request.output, { recursive: true });
        const chunks: Buffer[] = [];
        for (const name of names) {
          const body = Buffer.from('untrusted');
          const header = new Header({ path: name, type: 'File', mode: 0o644, size: body.length });
          header.encode();
          chunks.push(header.block!, body, Buffer.alloc(512 - body.length));
        }
        chunks.push(Buffer.alloc(1024));
        const archive = path.join(request.output, 'product.tgz');
        writeFileSync(archive, gzipSync(Buffer.concat(chunks)));
        writeReceipt(request.output, HEAD, archive);
        return { status: 0, stdout: '{}' };
      };
      expect(() => prepareApiCapability({ repoRoot, outputDir, runProducer: run }))
        .toThrow(/unsafe or duplicate member/);
      expect(existsSync(path.join(outputDir, 'unpacked'))).toBe(false);
      expect(existsSync(path.join(outputDir, 'escaped.txt'))).toBe(false);
    }
  });
});

describe('producer authority is not weakened', () => {
  it('the public CLI has no identity bypass and the local entry is programmatic only', () => {
    const source = readFileSync(path.join(repoRoot, 'scripts', 'api-module-producer.py'), 'utf8');
    expect(source).not.toContain('XPOD_API_LOCAL_IDENTITY');
    expect(source).toContain('def produce_for_local_build(request):');
    expect(source).toContain("raise ValueError('Unexpected producer workflow')");
    const mainBody = source.slice(source.indexOf('def main(argv=None):'), source.indexOf('def produce_for_local_build'));
    expect(mainBody).not.toContain('local-request');
    expect(mainBody).not.toContain('produce_for_local_build');
  });
});
