import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Bounded review export only. Original archives/data remain on the runner. */
export function exportModuleConsumerEvidence(root: string, output: string) {
  if (!path.isAbsolute(root) || realpathSync(root) !== root || path.dirname(output) !== root || existsSync(output)) {
    throw new Error('canonical root and new direct-child evidence output required');
  }
  mkdirSync(output, { mode: 0o700 });
  const files: { path: string; bytes: number; sha256: string; phase?: string }[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let total = 0;
  function copy(relative: string, json = true, expected?: { sha256: string; bytes?: number }, validate?: (value: any) => boolean, phase?: string) {
    try {
      const parts = relative.split('/');
      if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) throw new Error('unsafe path');
      let current = root;
      for (const part of parts) {
        current = path.join(current, part);
        if (lstatSync(current).isSymbolicLink()) throw new Error('symlink');
      }
      const stat = lstatSync(current);
      if (!stat.isFile() || stat.size > 16 * 1024 ** 2 || total + stat.size > 128 * 1024 ** 2) throw new Error('file or export bound');
      const bytes = readFileSync(current), digest = hash(bytes);
      if (bytes.length !== stat.size || (expected && ((expected.bytes !== undefined && expected.bytes !== bytes.length) || expected.sha256 !== digest))) throw new Error('reference mismatch');
      const parsed = json ? JSON.parse(bytes.toString('utf8')) : undefined;
      if (validate && !validate(parsed)) throw new Error('JSON binding mismatch');
      const destination = path.join(output, relative);
      mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, bytes, { flag: 'wx', mode: 0o400 });
      total += bytes.length; files.push({ path: relative, bytes: bytes.length, sha256: digest, ...(phase ? { phase } : {}) });
      return parsed;
    } catch (error) {
      const reason = error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'absent' : 'unsafe-invalid-or-unbound';
      skipped.push({ path: relative, reason });
      return undefined;
    }
  }
  const plan = copy('consumer-plan.json');
  for (const file of ['request.json', 'validation.json']) copy(file);
  let boundProducer: any;
  const reference = (value: any, expectedPath: string) => value && value.path === expectedPath
    && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.sha256)
    && (value.bytes === undefined || (Number.isSafeInteger(value.bytes) && value.bytes >= 0));
  for (const kind of ['product', 'cli']) {
    for (const file of ['receipt.json', 'metadata.json', 'metadata/run.original.json', 'metadata/workflow.original.json', 'metadata/artifact.original.json']) {
      copy(`acquisition-${kind}/${file}`);
    }
    if (kind === 'product') {
      const projectionPath = 'projection-product/projection.receipt.json';
      const planReference = plan?.cssReceipt ?? plan?.apiReceipt;
      if (reference(planReference, path.join(root, projectionPath))) {
        const projection = copy(projectionPath, true, planReference);
        if (reference(projection?.producerReceipt, 'producer.receipt.json')) {
          boundProducer = copy('projection-product/producer.receipt.json', true, projection.producerReceipt);
        } else skipped.push({ path: 'projection-product/producer.receipt.json', reason: 'producer-reference-unverified' });
      } else skipped.push({ path: projectionPath, reason: 'plan-reference-unverified' });
    } else copy('projection-cli/projection.receipt.json');
    for (const file of ['consumer-input.json', 'collector-input.json', 'publication-input.json']) {
      copy(`projection-${kind}/${file}`);
    }
  }
  const result = copy('consumer-results/result.json');
  const groupsKnown = result?.processGroupsUnknown === false;
  const closed = (row: any) => groupsKnown && row?.waitStatus === 'known' && row.rawClosed === true
    && row.rawClosedBeforeHash === true && row.rawEligible === true && row.ownedGroupAbsent === true;
  const records: any[] = Array.isArray(result?.records) ? result.records : [];
  const closedPhase = (label: string) => {
    const matches = records.filter(row => row.label === label);
    return matches.length === 1 && closed(matches[0]);
  };
  for (const row of records) {
    for (const raw of Array.isArray(row.raw) ? row.raw : []) {
      if (typeof raw.path !== 'string' || !/^[a-z0-9-]+\.(stdout|stderr)\.raw\.log$/u.test(raw.path)) continue;
      const relative = 'consumer-results/' + raw.path;
      if (!closed(row) || raw.sizeIsFinal !== true || typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.sha256)
        || !Number.isSafeInteger(raw.bytes) || raw.bytes < 0) {
        skipped.push({ path: relative, reason: 'raw-closure-unverified' });
      } else copy(relative, false, raw, undefined, row.label);
    }
  }
  const moduleId = plan?.cssReceipt && !plan.apiReceipt ? 'css' : plan?.apiReceipt && !plan.cssReceipt ? 'api' : undefined;
  for (const runtime of ['node', 'bun']) {
    const verification = result?.installedVerification?.[runtime];
    if (moduleId && verification?.fullInventoryVerified === true && closedPhase(`${runtime}-install-${moduleId}`)
      && typeof verification.manifestSha256 === 'string' && /^[a-f0-9]{64}$/u.test(verification.manifestSha256)) {
      const phase = `${runtime}-install-${moduleId}`;
      const installed = copy(`consumer-results/${runtime}-installed-package.json`, true, { sha256: verification.manifestSha256 }, undefined, phase);
      if (installed) copy(`consumer-results/${runtime}-pointer.json`, true, undefined, pointer => pointer?.manifestSha256 === verification.manifestSha256
        && pointer.package === installed.name && pointer.version === installed.version && pointer.integrity === plan[moduleId + 'Archive']?.integrity, phase);
      else skipped.push({ path: `consumer-results/${runtime}-pointer.json`, reason: 'installed-manifest-unverified' });
    } else if (moduleId) {
      for (const suffix of ['installed-package', 'pointer']) skipped.push({ path: `consumer-results/${runtime}-${suffix}.json`, reason: 'install-phase-or-inventory-unverified' });
    }
    const serviceProofs = moduleId === 'css' ? [['discovery', 'css-service']] : moduleId === 'api'
      ? [['api-health', 'api-service'], ['rdf-api-health', 'api-rdf']] : [];
    for (const [suffix, phase] of serviceProofs) {
      if (closedPhase(`${runtime}-${phase}`)) copy(`consumer-results/${runtime}-${suffix}.json`, true, undefined, undefined, `${runtime}-${phase}`);
      else skipped.push({ path: `consumer-results/${runtime}-${suffix}.json`, reason: 'phase-closure-unverified' });
    }
    if (!groupsKnown || result?.installedVerification?.[runtime]?.producerProvenanceVerified !== true) continue;
    const materials: any[] = boundProducer?.materials && typeof boundProducer.materials === 'object' && !Array.isArray(boundProducer.materials)
      ? Object.values(boundProducer.materials) : [];
    const counts = new Map<string, number>();
    for (const material of materials) if (typeof material?.archiveMember === 'string') {
      counts.set(material.archiveMember, (counts.get(material.archiveMember) ?? 0) + 1);
    }
    for (const material of materials) {
      const parts: string[] = typeof material?.archiveMember === 'string' ? material.archiveMember.split('/') : [];
      if (parts.length < 3 || parts[0] !== 'package' || parts[1] !== 'provenance'
        || parts.some(part => !part || part === '.' || part === '..' || !/^[a-zA-Z0-9._-]+$/u.test(part))
        || !parts[parts.length - 1].endsWith('.json') || counts.get(material.archiveMember) !== 1
        || typeof material.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(material.sha256)
        || !Number.isSafeInteger(material.bytes) || material.bytes < 0) {
        skipped.push({ path: `consumer-results/${runtime}-provenance`, reason: 'material-reference-unverified' });
        continue;
      }
      copy(`consumer-results/${runtime}-provenance/${parts.slice(2).join('/')}`, true, material);
    }
  }
  const manifest = { schemaVersion: 1, kind: 'module-consumer-review-export', files, skipped,
    processGroupsKnown: groupsKnown, bytes: total, originalArchivesExported: false, retainedDataExported: false,
    published: false, releaseQualified: false };
  writeFileSync(path.join(output, 'export.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
  return manifest;
}
if (import.meta.main) {
  try {
    if (process.argv.length !== 4) throw new Error('root and new evidence output required');
    exportModuleConsumerEvidence(process.argv[2], process.argv[3]);
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
