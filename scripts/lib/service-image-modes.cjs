const crypto = require('node:crypto');
const CHECK_NAME = 'runtime-mode-matrix';
const MODES = ['cloud', 'local', 'standalone'];
const CASES = ['renew', 'idle', 'expire'];
const LIMITS = Object.freeze({ commandMs: 600_000, liveMs: 300_000, browserMs: 300_000, cleanupMs: 60_000, outputBytes: 4 * 1024 * 1024, artifactBytes: 16 * 1024 * 1024 });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function requireFact(value, message) { if (!value) throw new Error(message); }
function assertSafeJson(value, depth = 0) {
  requireFact(depth <= 32, 'Safe original too deep');
  if (typeof value === 'string') requireFact(!/(?:Bearer\s+\S+|sk-[A-Za-z0-9+/_=-]{16,})/i.test(value), 'Secret-shaped original value');
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    requireFact(!/^(?:password|secret|clientSecret|client_secret|apiKey|access_token|refresh_token|cookie|authorization)$/i.test(key), 'Secret field in safe original');
    assertSafeJson(child, depth + 1);
  }
}
function projectLive(report, mode) {
  requireFact(report.mode === mode, 'Live mode mismatch');
  const layers = ['runtime', 'identity', 'podReadWrite', 'gatewayAuth', 'aiConnections', 'models', 'chat'];
  requireFact(layers.every(key => report.layers?.[key]?.ok === true), 'Incomplete live layers');
  requireFact(Array.isArray(report.modelIds) && report.modelIds.length > 0 && report.modelIds.every(x => typeof x === 'string' && x.trim().length > 0) && new Set(report.modelIds).size === report.modelIds.length && report.chatStatus === 200 && report.modelIds.includes(report.chatModel), 'Incomplete real models/Chat');
  requireFact(report.keyCleanup?.ok === true, 'Credential revocation incomplete');
  return { mode, layers: Object.fromEntries(layers.map(key => [key, true])), selectedModels: report.modelIds.length, chatStatus: 200, keyCleanup: true };
}
function sessionExpectedInput(report, mode, kind) {
  return { schemaVersion: 1, sourceSha: report.sourceSha, mode: mode.mode,
    baseUrl: mode.baseUrl, issuer: mode.issuer, image: { reference: report.image, platform: report.platform, id: mode.image.id },
    profile: { kind, ...report.policyConfigs[kind] }, binding: mode.sessionBindings[kind],
    ownershipRoot: '/owned', accountFile: '/owned/account', outputDirectory: '/owned/output' };
}
/**
 * The strict checks shared by the release matrix and the diagnostic matrix.
 *
 * Neither caller may relax these: image identity, per-mode mounts/runtime,
 * every canonical session case, the full command lifecycle, and cleanup. The
 * only difference between callers is the LIVE layer (release-only) and the
 * receipt kind policy, both handled by the public wrappers below.
 */
function validateMatrixCommon(report, expected, { requireLive }) {
  requireFact(report.schemaVersion === 1 && report.status === 'passed' && report.cancelled === false, 'Matrix not passed');
  for (const key of ['sourceSha', 'image', 'platform', 'runId', 'runAttempt']) requireFact(report[key] === expected[key], `Matrix ${key} mismatch`);
  requireFact(/^[a-f0-9]{40}$/.test(report.sourceSha) && /^.+@sha256:[a-f0-9]{64}$/.test(report.image), 'Invalid immutable inputs');
  requireFact(report.cleanup?.containersAbsent === true && report.cleanup?.volumesAbsent === true && report.cleanup?.networkAbsent === true && report.cleanup?.ownedCommandsClosed === true, 'Matrix cleanup incomplete');
  requireFact(Array.isArray(report.modes) && report.modes.length === MODES.length && new Set(report.modes.map(m => m.mode)).size === MODES.length, 'Missing/duplicate mode');
  for (const mode of MODES) {
    const m = report.modes.find(m => m.mode === mode);
    requireFact(m && m.image.reference === report.image && m.image.platform === report.platform && m.image.id === report.imageId && /^sha256:[a-f0-9]{64}$/.test(m.image.id) && m.image.repoDigests.includes(report.image), 'Mode image mismatch');
    requireFact(m.image.noCodeMounts === true && Array.isArray(m.image.mounts) && m.image.mounts.length > 0 && m.image.mounts.every(x => x.destination === '/app/data' && x.type === 'volume' || x.destination === '/app/config/main.json' && x.type === 'bind' && x.readOnly === true) && m.image.runtimeExecutables.length === 3 && m.image.runtimeExecutables.every(x => /\/bun$/.test(x)), 'Unverified service runtime');
    if (requireLive) {
      requireFact(m.live.mode === mode && m.live.keyCleanup === true && Number.isSafeInteger(m.live.selectedModels) && m.live.selectedModels > 0 && m.live.chatStatus === 200 && ['runtime', 'identity', 'podReadWrite', 'gatewayAuth', 'aiConnections', 'models', 'chat'].every(k => m.live.layers[k] === true), 'Mode live incomplete');
    } else {
      // The diagnostic must NOT carry a fabricated live proof.
      requireFact(m.live === undefined, 'Diagnostic matrix must not claim a live layer');
    }
    requireFact(Array.isArray(m.sessions) && m.sessions.length === CASES.length && new Set(m.sessions.map(x => x.profile?.kind)).size === CASES.length, 'Session cases missing');
    for (const kind of CASES) {
      requireFact(report.policyConfigs[kind]?.originalConfigSHA256 === report.baseConfigSHA256, 'Image config provenance mismatch');
      const x = m.sessions.find(x => x.profile?.kind === kind);
      require('./service-image-session-contract.cjs').validateReceipt(x, sessionExpectedInput(report, m, kind));
      requireFact(/^[a-f0-9]{64}$/.test(x.receiptSHA256), 'Browser original receipt missing');
    }
  }
  requireFact(Array.isArray(report.commands) && report.commands.length > 0 && report.commands.every(c => Number.isSafeInteger(c.timeoutMs) && c.timeoutMs > 0 && c.timeoutMs <= LIMITS.commandMs && Number.isSafeInteger(c.terminationGraceMs) && c.terminationGraceMs >= 1000 && c.terminationGraceMs <= 10000 && Number.isSafeInteger(c.finalObservationMs) && c.finalObservationMs >= c.terminationGraceMs + 1000 && c.finalObservationMs <= 15000 && c.exitObserved === true && c.rawEligible === true && c.waitKnown === true && c.closeObserved === true && c.groupAbsent === true && c.timedOut === false && c.cancelled === false && c.forcedCleanup === false && c.outputTruncated === false && c.spawnFailed === false && c.ownershipUnknown === false && c.code === 0 && c.signal === null && /^[a-f0-9]{64}$/.test(c.stdoutSHA256) && /^[a-f0-9]{64}$/.test(c.stderrSHA256)), 'Command lifecycle incomplete');
  requireFact(Object.keys(report.sources).length > 2 && require('./service-image-session-contract.cjs').validSources(report.sources), 'Runner source binding missing');
}

/** Release qualification: canonical kind policy, LIVE layer REQUIRED. Unchanged. */
function validateMatrix(report, expected) {
  requireFact(report.kind === undefined || report.kind === 'runtime-mode-matrix', 'Diagnostic matrix is not release qualification');
  requireFact(report.diagnosticOnly !== true && report.qualification !== false
    && report.notFullModeQualification !== true && report.liveChatExcluded !== true
    && report.platformInferenceExcluded !== true, 'Diagnostic matrix is not release qualification');
  validateMatrixCommon(report, expected, { requireLive: true });
  return { [CHECK_NAME]: 'passed' };
}

/**
 * Diagnostic session matrix: exact diagnostic kind + exclusion flags, the SAME
 * strict common checks (including every command-lifecycle field), but NO live
 * layer. Its result is deliberately NOT the release check name, so no consumer
 * can mistake it for qualification.
 */
function validateSessionMatrixDiagnostic(report, expected) {
  requireFact(report.kind === 'session-matrix-diagnostic', 'Diagnostic kind required');
  requireFact(report.diagnosticOnly === true && report.liveChatExcluded === true
    && report.platformInferenceExcluded === true && report.qualification === false
    && report.notFullModeQualification === true, 'Diagnostic exclusion flags required');
  // Deliberately NOT the release check name: this can never satisfy qualification.
  validateMatrixCommon(report, expected, { requireLive: false });
  return { 'session-matrix-diagnostic': 'passed' };
}

module.exports = { CHECK_NAME, MODES, CASES, LIMITS, hash, projectLive, validateMatrix, validateSessionMatrixDiagnostic, sessionExpectedInput, assertSafeJson };
