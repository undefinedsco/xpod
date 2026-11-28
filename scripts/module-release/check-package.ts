#!/usr/bin/env bun
/**
 * Static release checks for one module tarball (docs/module-publication-v2.md §3 step 2).
 *
 * Checks the package identity, the `xpodModule` file inventory, that every native
 * file can load on the target, the licence of every bundled npm package, and the
 * unpacked size budget. Writes a JSON report and a CycloneDX SBOM; exits non-zero
 * when any check fails. Nothing is executed from the package.
 *
 * Usage: bun scripts/module-release/check-package.ts <package.tgz> --module <id> [--target <platform-arch>] --out <dir>
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MODULE_TARGETS, modulePackageName } from '../../packages/xpod-cli/src/module-catalog';
import { verifyNativeMaterialTarget } from '../lib/physical-module-native';
import budgets from './budgets.json';
import licenseExceptions from './license-exceptions.json';

export type ReleaseModule = 'client' | 'cli' | 'api' | 'css' | 'afs';
const PORTABLE: Record<'client' | 'cli', string> = { client: '@undefineds.co/xpod-client', cli: '@undefineds.co/xpod-cli' };

/** Licences that only require the notice we already ship. */
const PERMISSIVE = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'BlueOak-1.0.0',
  'CC0-1.0', 'CC-BY-3.0', 'CC-BY-4.0', 'Unlicense', 'Python-2.0', 'Zlib', 'WTFPL', 'MIT-0',
  // Legacy spellings of BSD-2-Clause used by older packages.
  'BSD-2-Clause-FreeBSD', 'FreeBSD']);
/** Weak copyleft: allowed, but the corresponding source must be offered (§4). */
const SOURCE_OFFER = new Set(['LGPL-2.1', 'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0', 'LGPL-3.0-only',
  'LGPL-3.0-or-later', 'MPL-2.0', 'EPL-2.0']);

export interface CheckReport {
  package: string; version: string; module: ReleaseModule; target?: string;
  ok: boolean; failures: string[];
  unpackedBytes: number; budgetBytes: number;
  natives: { path: string; ok: boolean }[];
  sourceOffer: { name: string; version: string; license: string }[];
}

const NATIVE_HEADERS = new Set(['7f454c46', 'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
const FAT_HEADERS = new Set(['cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
const MACH_CPU: Record<number, string> = { 7: 'ia32', 12: 'arm', 0x01000007: 'x64', 0x0100000c: 'arm64' };

function isNative(bytes: Buffer): boolean {
  return NATIVE_HEADERS.has(bytes.subarray(0, 4).toString('hex')) || bytes.subarray(0, 2).toString() === 'MZ';
}

/** A universal Mach-O serves a darwin target when every slice is valid and one is that target. */
function fatServesTarget(bytes: Buffer, target: string): boolean {
  const magic = bytes.subarray(0, 4).toString('hex');
  const little = magic === 'bebafeca' || magic === 'bfbafeca', wide = magic === 'cafebabf' || magic === 'bfbafeca';
  const u32 = (at: number) => (little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at));
  if (!target.startsWith('darwin-') || bytes.length < 8) return false;
  try { verifyNativeMaterialTarget(bytes, 'darwin-universal'); } catch { return false; }
  const arches = new Set<string>();
  for (let i = 0; i < u32(4); i++) {
    const arch = MACH_CPU[u32(8 + i * (wide ? 32 : 20))];
    if (arch) arches.add(arch);
  }
  return arches.has(target.slice('darwin-'.length));
}

export function nativeServesTarget(bytes: Buffer, target: string): boolean {
  if (FAT_HEADERS.has(bytes.subarray(0, 4).toString('hex'))) return fatServesTarget(bytes, target);
  try { verifyNativeMaterialTarget(bytes, target); return true; } catch { return false; }
}

function walk(root: string, relative = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}

function licenseOf(manifest: { license?: unknown; licenses?: unknown }): string {
  const value = manifest.license ?? manifest.licenses;
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { type?: unknown }).type === 'string') return (value as { type: string }).type;
  if (Array.isArray(value)) return value.map(row => (typeof row === 'string' ? row : (row as { type?: string })?.type ?? '')).filter(Boolean).join(' OR ');
  return '';
}

/** Every SPDX alternative of `A OR B` must be checked; any allowed alternative suffices. */
function licenseClass(expression: string): 'permissive' | 'source-offer' | 'blocked' {
  const alternatives = expression.replace(/[()]/g, '').split(/\s+OR\s+/i).map(term => term.trim());
  if (alternatives.some(term => term.split(/\s+AND\s+/i).every(part => PERMISSIVE.has(part.trim())))) return 'permissive';
  if (alternatives.some(term => term.split(/\s+AND\s+/i).every(part => PERMISSIVE.has(part.trim()) || SOURCE_OFFER.has(part.trim())))) return 'source-offer';
  return 'blocked';
}

export function checkPackage(tarball: string, module: ReleaseModule, target: string | undefined, out: string): CheckReport {
  const failures: string[] = [];
  const work = mkdtempSync(path.join(tmpdir(), 'xpod-module-check-'));
  try {
    const extracted = spawnSync('tar', ['-xzf', tarball, '-C', work, '--no-same-owner'], { encoding: 'utf8' });
    if (extracted.status !== 0) throw new Error(`tarball extraction failed: ${extracted.stderr.trim()}`);
    const root = path.join(work, 'package');
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const portable = module === 'cli' || module === 'client';
    const [platform, arch] = (target ?? '').split('-');
    const expectedName = portable ? PORTABLE[module] : modulePackageName(module, platform ?? '', arch ?? '');
    if (!portable && !MODULE_TARGETS.some(row => `${row.platform}-${row.arch}` === target)) failures.push(`unsupported target: ${target}`);
    if (manifest.name !== expectedName) failures.push(`package name ${manifest.name} is not ${expectedName}`);
    if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) failures.push('package version is not exact SemVer');

    const files = walk(root);
    for (const file of files) {
      const stat = lstatSync(path.join(root, file));
      if (stat.isSymbolicLink() || !stat.isFile()) failures.push(`non-regular file: ${file}`);
    }

    if (!portable) {
      const declared = manifest.xpodModule;
      if (!declared || declared.schemaVersion !== 1 || declared.id !== module || declared.platform !== platform || declared.arch !== arch) {
        failures.push('xpodModule identity does not match module/target');
      } else {
        const inventory = new Map<string, { sha256: string; size: number; mode: number }>(
          (declared.files ?? []).map((row: { path: string; sha256: string; size: number; mode: number }) => [row.path, row]));
        const actual = files.filter(file => file !== 'package.json');
        for (const file of actual) {
          const row = inventory.get(file);
          if (!row) { failures.push(`file missing from xpodModule inventory: ${file}`); continue; }
          const bytes = readFileSync(path.join(root, file));
          const mode = lstatSync(path.join(root, file)).mode & 0o777;
          if (row.size !== bytes.length || row.sha256 !== createHash('sha256').update(bytes).digest('hex') || row.mode !== mode) {
            failures.push(`inventory mismatch: ${file}`);
          }
        }
        for (const file of inventory.keys()) if (!actual.includes(file)) failures.push(`inventory lists absent file: ${file}`);
        if (!inventory.has(declared.entry)) failures.push('xpodModule entry is not in the inventory');
      }
    }

    const natives: CheckReport['natives'] = [];
    if (!portable && target) {
      for (const file of files) {
        const bytes = readFileSync(path.join(root, file));
        if (!isNative(bytes)) continue;
        const ok = nativeServesTarget(bytes, target);
        natives.push({ path: file, ok });
        if (!ok) failures.push(`native file cannot load on ${target}: ${file}`);
      }
    }

    const components: object[] = [];
    const sourceOffer: CheckReport['sourceOffer'] = [];
    for (const file of files.filter(file => /(^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(file))) {
      const dependency = JSON.parse(readFileSync(path.join(root, file), 'utf8'));
      if (typeof dependency.name !== 'string' || typeof dependency.version !== 'string') continue;
      const license = licenseOf(dependency);
      // A package whose licence the checker cannot classify passes only through a
      // human-reviewed exception for that exact version (who reviewed it and why).
      const reviewed = (licenseExceptions.exceptions as { package: string; version: string; reason: string; reviewer: string }[])
        .some(row => row.package === dependency.name && row.version === dependency.version && row.reason && row.reviewer);
      const kind = reviewed ? 'permissive' : license ? licenseClass(license) : 'blocked';
      if (kind === 'blocked') failures.push(`licence not allowed: ${dependency.name}@${dependency.version} (${license || 'none'})`);
      if (kind === 'source-offer') sourceOffer.push({ name: dependency.name, version: dependency.version, license });
      components.push({ type: 'library', name: dependency.name, version: dependency.version,
        purl: `pkg:npm/${dependency.name.replace('@', '%40')}@${dependency.version}`,
        ...(license ? { licenses: [{ expression: license }] } : {}) });
    }

    const unpackedBytes = files.reduce((total, file) => total + lstatSync(path.join(root, file)).size, 0);
    const budgetBytes = (budgets.unpackedMiB as Record<string, number>)[module] * 1024 * 1024;
    if (!budgetBytes) failures.push(`no size budget declared for ${module}`);
    else if (unpackedBytes > budgetBytes) failures.push(`unpacked size ${(unpackedBytes / 1048576).toFixed(1)} MiB exceeds budget ${budgetBytes / 1048576} MiB`);

    mkdirSync(out, { recursive: true });
    const sbom = { bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
      metadata: { component: { type: 'application', name: manifest.name, version: manifest.version } }, components };
    writeFileSync(path.join(out, 'sbom.cdx.json'), JSON.stringify(sbom, null, 2) + '\n');
    const report: CheckReport = { package: manifest.name, version: manifest.version, module, ...(target ? { target } : {}),
      ok: failures.length === 0, failures, unpackedBytes, budgetBytes, natives, sourceOffer };
    writeFileSync(path.join(out, 'check-report.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [tarball, ...rest] = process.argv.slice(2);
  const option = (name: string) => { const at = rest.indexOf(name); return at === -1 ? undefined : rest[at + 1]; };
  const module = option('--module') as ReleaseModule | undefined;
  const out = option('--out');
  if (!tarball || !module || !out || !['client', 'cli', 'api', 'css', 'afs'].includes(module)) {
    console.error('usage: check-package.ts <package.tgz> --module <client|cli|api|css|afs> [--target <platform-arch>] --out <dir>');
    process.exit(64);
  }
  const report = checkPackage(path.resolve(tarball), module, option('--target'), path.resolve(out));
  console.log(JSON.stringify({ package: report.package, version: report.version, ok: report.ok, failures: report.failures.slice(0, 50) }, null, 2));
  process.exit(report.ok ? 0 : 1);
}
