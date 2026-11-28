#!/usr/bin/env bun
/**
 * Registry read-back for a module release (docs/module-publication-v2.md §3 step 5).
 *
 * For each locally built tarball: the registry's exact version must carry the same
 * integrity and serve identical bytes, and its npm provenance statement must name
 * this repository, the staging branch, this commit and this workflow run. Finally
 * `npm audit signatures` checks the registry signatures and attestations of a clean
 * install of exactly these versions. The downloaded copies are written to --out so
 * the next step installs what users will get.
 *
 * Usage: EXPECTED_REPOSITORY=owner/repo EXPECTED_SHA=<sha> EXPECTED_RUN=<run id> \
 *   bun scripts/module-release/verify-published.ts <a.tgz> [<b.tgz> ...] --out <dir>
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REGISTRY = 'https://registry.npmjs.org';
const SLSA_PROVENANCE = 'https://slsa.dev/provenance/v1';

export interface Expected { repository: string; sha: string; run: string }
interface Attestation { predicateType: string; bundle: { dsseEnvelope: { payload: string } } }

function packageIdentity(tarball: string): { name: string; version: string } {
  const result = spawnSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`cannot read package.json from ${tarball}`);
  const manifest = JSON.parse(result.stdout);
  return { name: manifest.name, version: manifest.version };
}

async function json(url: string): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

/** The SLSA provenance statement must bind this package digest to this repo, branch, commit and run. */
export function provenanceProblems(statement: any, name: string, sha512Hex: string, expected: Expected): string[] {
  const problems: string[] = [];
  const subject = (statement?.subject ?? []).find((row: any) => row?.digest?.sha512 === sha512Hex);
  if (!subject || !String(subject.name).startsWith(`pkg:npm/${name.replace('@', '%40')}@`)) problems.push('provenance subject does not match the package digest');
  const workflow = statement?.predicate?.buildDefinition?.externalParameters?.workflow ?? {};
  if (workflow.repository !== `https://github.com/${expected.repository}`) problems.push(`provenance repository is ${workflow.repository}`);
  if (workflow.ref !== 'refs/heads/staging') problems.push(`provenance ref is ${workflow.ref}`);
  if (workflow.path !== '.github/workflows/module-release.yml') problems.push(`provenance workflow is ${workflow.path}`);
  const commit = (statement?.predicate?.buildDefinition?.resolvedDependencies ?? []).find((row: any) => row?.digest?.gitCommit)?.digest?.gitCommit;
  if (commit !== expected.sha) problems.push(`provenance commit is ${commit}`);
  const invocation = String(statement?.predicate?.runDetails?.metadata?.invocationId ?? '');
  if (!invocation.includes(`/actions/runs/${expected.run}/`)) problems.push(`provenance run is ${invocation}`);
  return problems;
}

export async function verifyPublished(tarballs: string[], out: string, expected: Expected): Promise<string[]> {
  const failures: string[] = [];
  mkdirSync(out, { recursive: true });
  const installs: string[] = [];
  for (const tarball of tarballs) {
    const { name, version } = packageIdentity(tarball);
    const local = readFileSync(tarball);
    const integrity = `sha512-${createHash('sha512').update(local).digest('base64')}`;
    const metadata = await json(`${REGISTRY}/${name.replace('/', '%2f')}/${version}`);
    if (metadata.dist?.integrity !== integrity) { failures.push(`${name}@${version}: registry integrity differs from the built tarball`); continue; }
    const remote = Buffer.from(await (await fetch(metadata.dist.tarball, { signal: AbortSignal.timeout(120_000) })).arrayBuffer());
    if (!remote.equals(local)) { failures.push(`${name}@${version}: registry tarball bytes differ`); continue; }
    writeFileSync(path.join(out, path.basename(tarball)), remote);
    const attestations = await json(`${REGISTRY}/-/npm/v1/attestations/${name.replace('/', '%2f')}@${version}`)
      .catch(() => ({ attestations: [] })) as { attestations: Attestation[] };
    const provenance = attestations.attestations.find(row => row.predicateType === SLSA_PROVENANCE);
    if (!provenance) { failures.push(`${name}@${version}: no SLSA provenance attestation`); continue; }
    const statement = JSON.parse(Buffer.from(provenance.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
    for (const problem of provenanceProblems(statement, name, createHash('sha512').update(local).digest('hex'), expected)) failures.push(`${name}@${version}: ${problem}`);
    installs.push(`${name}@${version}`);
  }
  if (installs.length === tarballs.length) {
    // Cryptographic check of registry signatures and attestations, on a clean install of exactly these versions.
    const project = mkdtempSync(path.join(tmpdir(), 'xpod-audit-signatures-'));
    try {
      writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'audit', private: true }));
      const install = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...installs], { cwd: project, encoding: 'utf8' });
      if (install.status !== 0) failures.push(`npm install of published versions failed: ${install.stderr.slice(0, 600)}`);
      else {
        const audit = spawnSync('npm', ['audit', 'signatures'], { cwd: project, encoding: 'utf8' });
        if (audit.status !== 0) failures.push(`npm audit signatures failed: ${(audit.stdout + audit.stderr).slice(0, 600)}`);
      }
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }
  return failures;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--out');
  const out = at === -1 ? undefined : args[at + 1];
  const tarballs = args.filter((value, index) => index !== at && index !== at + 1);
  const expected = { repository: process.env.EXPECTED_REPOSITORY ?? '', sha: process.env.EXPECTED_SHA ?? '', run: process.env.EXPECTED_RUN ?? '' };
  if (!out || !tarballs.length || !expected.repository || !expected.sha || !expected.run) {
    console.error('usage: EXPECTED_REPOSITORY=… EXPECTED_SHA=… EXPECTED_RUN=… verify-published.ts <a.tgz> [...] --out <dir>');
    process.exit(64);
  }
  const failures = await verifyPublished(tarballs.map(file => path.resolve(file)), path.resolve(out), expected);
  for (const failure of failures) console.error(`FAIL ${failure}`);
  if (!failures.length) console.log(`ok   ${tarballs.length} package(s) match the registry, provenance and signatures`);
  process.exit(failures.length ? 1 : 0);
}
