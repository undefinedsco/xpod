const fs = require('node:fs');

/** A downstream cleanup must never scale another run's shared RC service. */
function ownsRcDeployment(deployment, namespace, seedSecretName) {
  return deployment?.metadata?.name === 'xpod-rc'
    && deployment.metadata.namespace === namespace
    && /^xpod-rc-seed-\d+-\d+$/.test(seedSecretName)
    && deployment.spec?.template?.spec?.volumes?.some(volume => volume?.secret?.secretName === seedSecretName) === true;
}

function ownsRcPostgres(statefulset, namespace, seedSecretName) {
  return statefulset?.metadata?.name === 'xpod-rc-postgres'
    && statefulset.metadata.namespace === namespace
    && /^xpod-rc-seed-\d+-\d+$/.test(seedSecretName)
    && statefulset.metadata.annotations?.['xpod.undefineds.co/rc-owner-seed'] === seedSecretName;
}

module.exports = { ownsRcDeployment, ownsRcPostgres };
if (require.main === module) {
  try {
    const [kind, file, namespace, seed] = process.argv.slice(2);
    if (!['deployment', 'postgres'].includes(kind) || !file || !namespace || !seed || process.argv.length !== 6) throw new Error('Invalid arguments');
    const text = fs.readFileSync(file, 'utf8');
    process.exitCode = (kind === 'deployment' ? ownsRcDeployment : ownsRcPostgres)(text.trim() ? JSON.parse(text) : null, namespace, seed) ? 0 : 2;
  } catch { console.error('RC cleanup ownership could not be verified'); process.exitCode = 1; }
}
