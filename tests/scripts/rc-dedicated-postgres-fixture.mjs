/**
 * Shared fixture for the RC-dedicated PostgreSQL integration tests.
 *
 * Everything here resolves against THIS repository: the tests import the real
 * workflow, renderer, boundary validator, ownership helper and templates. There
 * is no absolute path to a prototype workspace and no copied algorithm; the
 * only module-level constants are paths and a synthetic immutable digest used
 * where the renderer needs *an* image.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requireFromRoot = createRequire(path.join(repoRoot, 'package.json'));

export const YAML = requireFromRoot('yaml');

export const workflowPath = path.join(repoRoot, '.github/workflows/candidate.yml');
export const rcOverlayPath = path.join(repoRoot, 'deploy/sealos/rc');
export const bootstrapManifestPath = path.join(rcOverlayPath, 'postgres-bootstrap.yaml');
export const postgresManifestPath = path.join(rcOverlayPath, 'postgres.yaml');
export const readinessScriptPath = path.join(repoRoot, 'scripts/verify-protected-rc-database.sh');

export const read = (file) => readFileSync(file, 'utf8');
export const readWorkflowText = () => read(workflowPath);
export const loadWorkflow = () => YAML.parse(readWorkflowText());
export const deploySteps = () => loadWorkflow().jobs.deploy_and_accept.steps;
export const cleanupSteps = () => loadWorkflow().jobs.cleanup_rc.steps;

export function findStep(steps, needle) {
  const step = steps.find((entry) => (entry.name ?? '').includes(needle));
  if (!step) throw new Error(`workflow step not found: ${needle}`);
  if (typeof step.run !== 'string') throw new Error(`step has no run block: ${needle}`);
  return step;
}

/** Load a real repository module by repo-relative path. */
export function requireRepoModule(relativePath) {
  return requireFromRoot(path.join(repoRoot, relativePath));
}

/** Parse every YAML document in a file or string. */
export function yamlObjects(text) {
  return YAML.parseAllDocuments(text)
    .map((document) => document.toJSON())
    .filter(Boolean);
}

/** Synthetic immutable digest; never a claim about the deployed PG image. */
export function syntheticDigest(label = 'a') {
  return `ccr.ccs.tencentyun.com/undefineds/xpod-rdf-postgres@sha256:${label.repeat(64)}`;
}

/**
 * GitHub Actions materializes `${{ ... }}` expressions in `run:` bodies BEFORE
 * the runner ever starts a shell. A locally extracted step body therefore still
 * contains those tokens verbatim, and real Bash rejects `${{` with
 * "bad substitution". This substitutes only the expressions a fixture supplies,
 * mirroring the runner's pre-shell templating; anything not supplied stays
 * visible so a missing value fails loudly instead of being silently invented.
 */
export function materializeExpressions(source, values = {}) {
  return source.replace(/\$\{\{\s*([^{}]+?)\s*\}\}/gu, (token, expression) => {
    const key = expression.trim();
    if (!Object.hasOwn(values, key)) {
      throw new Error(`fixture did not supply the GitHub expression: ${token}`);
    }
    return String(values[key]);
  });
}

export const syntheticAppImage = `ghcr.io/undefinedsco/xpod@sha256:${'a'.repeat(64)}`;

/** Temporary directory removed after the node:test case. */
export function tempDir(t, prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Run a shell script with a controlled environment, returning the result. */
export function runShell(shell, args, script, { cwd = repoRoot, env = {}, timeout = 120_000 } = {}) {
  return spawnSync(shell, [...args, script], {
    cwd,
    encoding: 'utf8',
    timeout,
    env: { PATH: process.env.PATH, ...env },
  });
}

export function writeExecutable(file, contents) {
  writeFileSync(file, contents, { mode: 0o700 });
}

export function fileMode(file) {
  return statSync(file).mode & 0o777;
}

export { execFileSync, spawnSync };
