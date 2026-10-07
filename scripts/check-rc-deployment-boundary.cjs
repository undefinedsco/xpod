#!/usr/bin/env node
const { execFileSync } = require('node:child_process');

function validateBoundary(config, namespace) {
  const context = config.contexts?.find(entry => entry.name === config['current-context'])?.context;
  const server = config.clusters?.find(entry => entry.name === context?.cluster)?.cluster?.server;
  if (server !== 'https://gzg.sealos.run:6443' || namespace !== 'ns-iknkxtc8') {
    throw new Error('RC requires the GZ cluster and namespace ns-iknkxtc8');
  }
}

function validateDatabases(entries) {
  const urls = ['CSS_IDENTITY_DB_URL', 'CSS_SPARQL_ENDPOINT'].map(key => {
    let url;
    try { url = new URL(entries.get(key)); } catch { throw new Error(`invalid RC database URL: ${key}`); }
    const hosts = ['xpod-rdf-postgres', 'xpod-rdf-postgres.ns-iknkxtc8.svc',
      'xpod-rdf-postgres.ns-iknkxtc8.svc.cluster.local'];
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !hosts.includes(url.hostname)
      || (url.port && url.port !== '5432') || url.pathname !== '/xpod_rc'
      || url.username !== 'xpod_rc' || !url.password || url.search || url.hash) {
      throw new Error(`${key} must use the isolated xpod_rc role/database on the GZ shared PostgreSQL`);
    }
    return url;
  });
  if (urls[0].password !== urls[1].password) {
    throw new Error('RC identity and RDF database credentials must match');
  }
  for (const key of ['DATABASE_URL', 'CSS_TASK_DB_URL']) {
    if (entries.has(key) && entries.get(key) !== entries.get('CSS_IDENTITY_DB_URL')
      && entries.get(key) !== entries.get('CSS_SPARQL_ENDPOINT')) {
      throw new Error(`conflicting RC database authority: ${key}`);
    }
  }
}

if (require.main === module) {
  const config = JSON.parse(execFileSync('kubectl', ['config', 'view', '--minify', '-o', 'json'], { encoding: 'utf8' }));
  validateBoundary(config, process.env.SEALOS_NAMESPACE);
}

module.exports = { validateBoundary, validateDatabases };
