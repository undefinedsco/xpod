#!/usr/bin/env node
/** Same verifier for candidate aggregation and stable promotion; built-in Node modules only. */
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createModeEvidenceReader, readCanonicalFile } = require('./lib/mode-evidence-reader.cjs');
const { hash, projectLive, validateMatrix, sessionExpectedInput, assertSafeJson } = require('./lib/service-image-modes.cjs');
const { validateModeArtifactAuthority } = require('./lib/mode-artifact-authority.cjs');
const { validateReceipt, validSources } = require('./lib/service-image-session-contract.cjs');
async function verifyModeEvidence(directory, expected, repoRoot) {
  const evidence = await createModeEvidenceReader(directory);
  const declared = new Set(['matrix.safe.json']);
  const report = JSON.parse((await evidence.read('matrix.safe.json')).toString()); assertSafeJson(report);
  const checks = validateMatrix(report, expected);
  const verifySources = async sources => {
    if (!validSources(sources)) throw new Error('Invalid canonical source bindings');
    for (const [file, sha] of Object.entries(sources)) if (hash(await readCanonicalFile(repoRoot, file)) !== sha) throw new Error('Verifier source binding mismatch');
  };
  for (const mode of report.modes) {
    const liveName = `live-${mode.mode}.original.json`; declared.add(liveName);
    const live = await evidence.read(liveName); const parsedLive = JSON.parse(live.toString()); assertSafeJson(parsedLive);
    if (hash(live) !== mode.liveOriginalSHA256 || JSON.stringify(projectLive(parsedLive, mode.mode)) !== JSON.stringify(mode.live)) throw new Error('Live original mismatch');
    for (const session of mode.sessions) {
      const prefix = `session-${mode.mode}-${session.profile.kind}`;
      const receiptName = `${prefix}/session.safe.json`; declared.add(receiptName);
      const original = await evidence.read(receiptName);
      if (hash(original) !== session.receiptSHA256) throw new Error('Browser original receipt mismatch');
      const parsed = JSON.parse(original.toString()); assertSafeJson(parsed);
      validateReceipt(parsed, sessionExpectedInput(report, mode, parsed.profile.kind));
      const { receiptSHA256, ...projected } = session;
      if (JSON.stringify(parsed) !== JSON.stringify(projected)) throw new Error('Browser projection mismatch');
      for (const member of parsed.originals) {
        const name = `${prefix}/${member.path}`; declared.add(name);
        const bytes = await evidence.read(name); assertSafeJson(JSON.parse(bytes.toString()));
        if (bytes.length !== member.bytes || hash(bytes) !== member.sha256) throw new Error('Browser safe original mismatch');
      }
      await verifySources(parsed.sources);
    }
  }
  await verifySources(report.sources);
  if (evidence.files.length !== declared.size || evidence.files.some(name => !declared.has(name))) throw new Error('Unexpected safe artifact member');
  return checks;
}
async function main(argv) {
  const allowed = ['directory', 'source-sha', 'image', 'platform', 'run-id', 'run-attempt', 'checks-out', 'selection-file', 'artifact-file', 'jobs-file', 'producer-check']; const args = {};
  for (let n = 0; n < argv.length; n += 2) {
    const key = argv[n]?.replace(/^--/, ''); if (!argv[n]?.startsWith('--') || !allowed.includes(key) || Object.hasOwn(args, key) || !argv[n + 1]) throw new Error('Invalid verifier arguments'); args[key] = argv[n + 1];
  }
  if (allowed.slice(0,6).some(key => !args[key])) throw new Error('Missing immutable verifier input');
  const repoRoot = path.resolve(__dirname, '..');
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 4096 }).trim();
  if (actual !== args['source-sha']) throw new Error('Verifier checkout source mismatch');
  const expected = { sourceSha: args['source-sha'], image: args.image, platform: args.platform, runId: args['run-id'], runAttempt: args['run-attempt'] };
  const modeChecks = await verifyModeEvidence(args.directory, expected, repoRoot);
  let checks;
  if (args['producer-check'] === 'true') {
    if (args['selection-file'] || args['artifact-file'] || args['jobs-file'] || args['checks-out'] || process.env.GITHUB_JOB !== 'runtime_mode_matrix' || process.env.GITHUB_RUN_ID !== expected.runId || process.env.GITHUB_RUN_ATTEMPT !== expected.runAttempt) throw new Error('Producer precheck is not a promotion check');
    checks = { 'runtime-mode-matrix-precheck': 'passed' };
  } else {
    if (args['producer-check'] || !args['selection-file'] || !args['artifact-file'] || !args['jobs-file']) throw new Error('Matrix actual job/artifact authority required');
    const readMetadata = async file => JSON.parse((await readCanonicalFile(path.dirname(path.resolve(file)), path.basename(file))).toString());
    validateModeArtifactAuthority(await readMetadata(args['selection-file']), await readMetadata(args['artifact-file']), await readMetadata(args['jobs-file']), expected);
    checks = modeChecks;
  }
  if (args['checks-out']) await fs.writeFile(args['checks-out'], JSON.stringify(checks) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify(checks) + '\n');
}
module.exports = { verifyModeEvidence, main };
if (require.main === module) main(process.argv.slice(2)).catch(() => { process.stderr.write('Mode artifact original verification failed\n'); process.exitCode = 1; });
