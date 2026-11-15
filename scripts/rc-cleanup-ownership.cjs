const fs = require('node:fs');

/** Annotation a failed candidate leaves on the RC it kept running for diagnosis. */
const RETAINED_ANNOTATION = 'xpod.undefineds.co/retained-for-diagnosis';
const SEED_PATTERN = /^xpod-rc-seed-\d+-\d+$/;

function mountedSeeds(deployment) {
  return (deployment?.spec?.template?.spec?.volumes ?? [])
    .map(volume => volume?.secret?.secretName)
    .filter(name => typeof name === 'string' && SEED_PATTERN.test(name));
}

/** A downstream cleanup must never scale another run's shared RC service. */
function ownsRcDeployment(deployment, namespace, seedSecretName) {
  return deployment?.metadata?.name === 'xpod-rc'
    && deployment.metadata.namespace === namespace
    && SEED_PATTERN.test(seedSecretName)
    && mountedSeeds(deployment).includes(seedSecretName);
}

/**
 * The seed this workflow run (any attempt) deployed, if the live RC is still
 * that run's. A re-run of failed acceptance jobs has a new attempt number but
 * still owns the RC its original attempt deployed and retained.
 */
function runSeedOfRcDeployment(deployment, namespace, runId) {
  if (deployment?.metadata?.name !== 'xpod-rc' || deployment.metadata.namespace !== namespace) return undefined;
  if (!/^\d+$/.test(String(runId))) return undefined;
  return mountedSeeds(deployment).find(name => name.startsWith(`xpod-rc-seed-${runId}-`));
}

/**
 * The seed of an RC a failed candidate deliberately left running. Only the
 * retained annotation naming that same mounted seed qualifies, so a later apply
 * that replaced the seed never counts as retained.
 */
function retainedRcSeed(deployment, namespace) {
  const seed = deployment?.metadata?.annotations?.[RETAINED_ANNOTATION];
  return typeof seed === 'string' && ownsRcDeployment(deployment, namespace, seed) ? seed : undefined;
}

function ownsRcPostgres(statefulset, namespace, seedSecretName) {
  return statefulset?.metadata?.name === 'xpod-rc-postgres'
    && statefulset.metadata.namespace === namespace
    && SEED_PATTERN.test(seedSecretName)
    && statefulset.metadata.annotations?.['xpod.undefineds.co/rc-owner-seed'] === seedSecretName;
}

module.exports = { ownsRcDeployment, ownsRcPostgres, runSeedOfRcDeployment, retainedRcSeed, RETAINED_ANNOTATION };
if (require.main === module) {
  try {
    const [kind, file, namespace, value] = process.argv.slice(2);
    const text = file ? fs.readFileSync(file, 'utf8') : '';
    const object = text.trim() ? JSON.parse(text) : null;
    if (kind === 'retained' || kind === 'run-seed') {
      // Prints the matching seed; exit 2 when there is none.
      if (!namespace || process.argv.length !== (kind === 'retained' ? 5 : 6)) throw new Error('Invalid arguments');
      const seed = kind === 'retained' ? retainedRcSeed(object, namespace) : runSeedOfRcDeployment(object, namespace, value);
      if (seed) process.stdout.write(`${seed}\n`);
      process.exitCode = seed ? 0 : 2;
    } else {
      if (!['deployment', 'postgres'].includes(kind) || !file || !namespace || !value || process.argv.length !== 6) throw new Error('Invalid arguments');
      process.exitCode = (kind === 'deployment' ? ownsRcDeployment : ownsRcPostgres)(object, namespace, value) ? 0 : 2;
    }
  } catch { console.error('RC cleanup ownership could not be verified'); process.exitCode = 1; }
}
