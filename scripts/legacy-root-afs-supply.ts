// Same-run custody and original byte projection; no product production in a consumer lane.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { acquireLegacyRootSupply, type ArtifactAcquisitionInput } from './acquire-independent-product-input';
const require = createRequire(import.meta.url);
const io = require('./lib/root-registry-supply.cjs');
const normal = require('./lib/legacy-afs-supply.cjs');
export async function acquire(input: ArtifactAcquisitionInput, output: string) {
  fs.mkdirSync(output);
  const custody = path.join(output, 'custody');
  const receipt = await acquireLegacyRootSupply(input, custody, { token: process.env.GH_TOKEN, diagnostics: path.join(output, 'diagnostics/acquisition') });
  const originals = path.join(output, 'originals'); fs.mkdirSync(originals);
  const members = receipt.inventory.members;
  const indexRows = members.filter((row: any) => row.path === 'supply-index.original.json' && row.kind === 'file');
  if (indexRows.length !== 1 || indexRows[0].bytes > 8 * 1024 ** 2) throw new Error('Unique original supply index required');
  const project = (rows: any[]) => {
    const result = require('./lib/product-artifact-command.cjs').inspectArtifact([path.join(import.meta.dir, 'lib/inspect-product-artifact.py'), path.join(custody, 'artifact.zip'), input.artifactSha256,
      String(16 * 1024 ** 2), String(40 * 1024 ** 2), '4096', '--selection-stdin', originals, 'legacy-root-normal-supply'], { input: Buffer.from(JSON.stringify(rows.map(row => ({ path: row.path, destination: row.path, bytes: row.bytes, sha256: row.sha256 })))), evidence: path.join(output, 'diagnostics/projection'), label: 'zip-projection', timeout: 30_000, maxBuffer: 8 * 1024 ** 2 });
    if (result.error || result.status !== 0) throw new Error('Normal supply ZIP projection failed: ' + result.stderr);
  };
  project(indexRows);
  const index = JSON.parse(io.readRegular(path.join(originals, 'supply-index.original.json')));
  if (!Array.isArray(index.members) || index.members.length > 4095) throw new Error('Supply inventory required');
  const selected = index.members.map((row: any) => {
    normal.portable(row.member);
    const matches = members.filter((member: any) => member.path === row.member && member.kind === 'file' && member.bytes === row.bytes && member.sha256 === row.sha256);
    if (matches.length !== 1) throw new Error('Normal supply member binding mismatch'); return matches[0];
  });
  if (new Set(selected.map((row: any) => row.path)).size !== selected.length || members.filter((row: any) => row.kind === 'file').length !== selected.length + 1) throw new Error('Unexpected or duplicate ZIP original');
  project(selected);
  normal.verify(originals, input, process.cwd());
  fs.writeFileSync(path.join(output, 'request.original.json'), JSON.stringify({ input, custodyReceipt: io.reference(path.join(custody, 'receipt.json')), index: io.reference(path.join(originals, 'supply-index.original.json')) }, null, 2) + '\n', { flag: 'wx' });
}
if (import.meta.main) {
  if (process.argv[2] === 'produce' && process.argv.length === 5) await normal.produce(process.cwd(), path.resolve(process.argv[3]), process.argv[4]);
  else if (process.argv[2] === 'acquire' && process.argv.length === 4) await acquire({ schemaVersion: 1, sourceSha: process.env.SOURCE_SHA!, runHeadSha: process.env.RUN_HEAD_SHA!, runId: Number(process.env.GITHUB_RUN_ID), runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT), artifactId: Number(process.env.SUPPLY_ARTIFACT_ID), artifactSha256: process.env.SUPPLY_ARTIFACT_SHA256! }, path.resolve(process.argv[3]));
  else throw new Error('produce output sourceSHA or acquire output required');
}
