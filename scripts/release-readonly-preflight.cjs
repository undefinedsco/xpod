#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');
const { selectServiceContainer } = require('./lib/production-deployment-container.cjs');
class PreflightError extends Error { constructor(code) { super(code); this.code = code; } }
function read(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30000 });
  if (result.status !== 0 || result.signal) throw new PreflightError('preflight_read_unavailable');
  try { return JSON.parse(result.stdout); } catch { throw new PreflightError('preflight_invalid_response'); }
}
function matches(pattern, name) {
  // Unsupported fnmatch syntax fails closed; administrators may use exact refs or '*'.
  if (typeof pattern !== 'string' || /[?\[\]\\]/.test(pattern)) return false;
  return new RegExp(`^${pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`).test(name);
}
function environmentAllowed(environment, policies, refType, refName, protectedBranch = false) {
  const policy = environment.deployment_branch_policy;
  if (!policy) return true;
  if (policy.protected_branches) return refType === 'branch' && protectedBranch;
  if (!policy.custom_branch_policies) throw new PreflightError('preflight_environment_policy_unknown');
  return policies.some(row => row.type === refType && matches(row.name, refName));
}
function environmentCheck(api, repo, name, refType, refName, requiredSecrets, requiredVariables) {
  if (!/^[A-Za-z0-9_-]+$/.test(name) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new PreflightError('preflight_invalid_target');
  const prefix = `repos/${repo}/environments/${name}`;
  const environment = api(prefix);
  const policies = environment.deployment_branch_policy?.custom_branch_policies ? api(`${prefix}/deployment-branch-policies?per_page=100`).branch_policies : [];
  const protectedBranch = refType === 'branch' && environment.deployment_branch_policy?.protected_branches
    ? api(`repos/${repo}/branches/${encodeURIComponent(refName)}`).protected === true : false;
  if (!environmentAllowed(environment, policies || [], refType, refName, protectedBranch)) throw new PreflightError('preflight_ref_not_allowed');
  const secrets = requiredSecrets.length ? api(`${prefix}/secrets?per_page=100`).secrets : [];
  const variables = requiredVariables.length ? api(`${prefix}/variables?per_page=100`).variables : [];
  if (requiredSecrets.some(name => !secrets?.some(row => row.name === name))) throw new PreflightError('preflight_secret_metadata_missing');
  if (requiredVariables.some(name => !variables?.some(row => row.name === name && typeof row.value === 'string' && row.value.trim()))) throw new PreflightError('preflight_variable_missing');
  return { environment: name, refAllowed: true, requiredSecretNames: requiredSecrets, requiredVariableNames: requiredVariables };
}
function references(deployment, targetImage) {
  let service;
  try { service = selectServiceContainer(deployment, targetImage); } catch { throw new PreflightError('preflight_service_container_invalid'); }
  const spec = deployment.spec.template.spec;
  const container = spec.containers.find(row => row.name === service.serviceContainer);
  if (![...(container.command || []), ...(container.args || [])].some(value => /(?:xpod|cloud|main|start)/.test(value))) throw new PreflightError('preflight_startup_contract_missing');
  const result = [];
  const add = (kind, ref, all = false) => { if (!ref?.name) throw new PreflightError('preflight_reference_invalid'); result.push({ kind, name: ref.name, key: ref.key, optional: ref.optional === true, all }); };
  // Kubelet validates every container and initContainer, not only the app container.
  for (const row of [...spec.containers, ...(spec.initContainers || [])]) {
    for (const env of row.env || []) {
      if (env.valueFrom?.secretKeyRef) add('secret', env.valueFrom.secretKeyRef);
      if (env.valueFrom?.configMapKeyRef) add('configmap', env.valueFrom.configMapKeyRef);
    }
    for (const env of row.envFrom || []) {
      if (env.secretRef) add('secret', env.secretRef, true);
      if (env.configMapRef) add('configmap', env.configMapRef, true);
    }
  }
  for (const volume of spec.volumes || []) {
    for (const item of [{ secret: volume.secret && { ...volume.secret, name: volume.secret.secretName }, configMap: volume.configMap }, ...(volume.projected?.sources || [])]) {
      for (const [key, kind] of [['secret', 'secret'], ['configMap', 'configmap']]) {
        const ref = item[key]; if (!ref) continue;
        if (ref.items?.length) for (const item of ref.items) add(kind, { ...ref, key: item.key });
        else add(kind, ref, true);
      }
    }
  }
  for (const ref of spec.imagePullSecrets || []) add('secret', ref, true);
  return { serviceContainer: service.serviceContainer, references: result };
}
function deploymentCheck(get, deployment, targetImage, expectedBaseUrl) {
  const contract = references(deployment, targetImage); const cache = new Map(); const checks = [];
  for (const ref of contract.references) {
    // Required references only. Do not read unused or optional credentials.
    if (ref.optional) continue;
    const id = `${ref.kind}/${ref.name}`;
    if (!cache.has(id)) cache.set(id, get(ref.kind, ref.name));
    const resource = cache.get(id);
    const data = { ...resource.binaryData, ...resource.data };
    const keys = ref.all ? Object.keys(data) : [ref.key];
    if (!ref.all && keys.some(key => typeof data[key] !== 'string' || !(ref.kind === 'secret' ? Buffer.from(data[key], 'base64').length : data[key].length))) throw new PreflightError('preflight_reference_key_missing_or_empty');
    checks.push({ resource: id, keys, passed: true });
  }
  if (expectedBaseUrl) {
    const container = deployment.spec.template.spec.containers.find(row => row.name === contract.serviceContainer);
    const environment = {};
    const resourceValue = (kind, name, key) => {
      const resource = cache.get(`${kind}/${name}`);
      const value = resource?.data?.[key];
      return typeof value === 'string' ? kind === 'secret' ? Buffer.from(value, 'base64').toString('utf8') : value : undefined;
    };
    for (const row of container.envFrom || []) {
      const kind = row.secretRef ? 'secret' : 'configmap'; const ref = row.secretRef || row.configMapRef;
      if (!ref) continue;
      const resource = cache.get(`${kind}/${ref.name}`);
      for (const key of Object.keys(resource?.data || {})) environment[`${row.prefix || ''}${key}`] = resourceValue(kind, ref.name, key);
    }
    for (const row of container.env || []) {
      const ref = row.valueFrom?.secretKeyRef || row.valueFrom?.configMapKeyRef;
      environment[row.name] = row.value !== undefined ? row.value : ref ? resourceValue(row.valueFrom.secretKeyRef ? 'secret' : 'configmap', ref.name, ref.key) : undefined;
    }
    if (environment.XPOD_EDITION !== 'cloud') throw new PreflightError('preflight_production_edition_invalid');
    let base; try { base = new URL(environment.CSS_BASE_URL).origin; } catch { throw new PreflightError('preflight_production_route_invalid'); }
    if (base !== expectedBaseUrl) throw new PreflightError('preflight_production_route_invalid');
    for (const key of ['CSS_IDENTITY_DB_URL', 'CSS_SPARQL_ENDPOINT']) {
      let database; try { database = new URL(environment[key]); } catch { throw new PreflightError('preflight_production_database_invalid'); }
      if (!['postgres:', 'postgresql:'].includes(database.protocol) || /(?:^|\/)xpod_rc(?:$|\/)/i.test(database.pathname) || !database.pathname.slice(1)) throw new PreflightError('preflight_production_database_invalid');
    }
    checks.push({ runtimeBoundary: 'cloud-public-route-and-production-databases', passed: true });
  }
  return { serviceContainer: contract.serviceContainer, checks };
}
function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const refName = process.env.GITHUB_REF_NAME; const refType = process.env.GITHUB_REF_TYPE;
  const namespace = process.env.SEALOS_NAMESPACE;
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace || '')) throw new PreflightError('preflight_invalid_namespace');
  const get = (kind, name) => read('kubectl', ['-n', namespace, 'get', kind, name, '-o', 'json']);
  if (process.argv.includes('--deployment-only')) {
    const name = process.env.XPOD_DEPLOYMENT;
    if (!/^xpod-(co|cn)$/.test(name || '')) throw new PreflightError('preflight_invalid_target');
    console.log(JSON.stringify({ status: 'passed', deployment: deploymentCheck(get, get('deployment', name), process.env.TARGET_IMAGE, `https://id.undefineds.${name.slice(5)}`) })); return;
  }
  const api = route => read('gh', ['api', route]);
  const environments = [environmentCheck(api, repo, 'co', refType, refName, ['KUBE_CONFIG_DATA'], ['SEALOS_NAMESPACE']),
    environmentCheck(api, repo, process.env.XPOD_STABLE_DESKTOP_ENVIRONMENT || 'rc', refType, refName, ['XPOD_LIVE_PROVIDER_API_KEY_CONFIG'], [])];
  const deployment = deploymentCheck(get, get('deployment', 'xpod-co'), `ghcr.io/${repo}@${process.env.ACCEPTED_IMAGE_DIGEST}`, 'https://id.undefineds.co');
  // Infrastructure boundaries must be present; do not print their contents.
  for (const [kind, name] of [['statefulset', 'xpod-rdf-postgres'], ['deployment', 'gateway'], ['configmap', 'gateway'], ['deployment', 'xpod-inngest']]) get(kind, name);
  console.log(JSON.stringify({ schemaVersion: 1, status: 'passed', environments, deployment, infrastructure: 'present' }));
}
module.exports = { PreflightError, matches, environmentAllowed, environmentCheck, references, deploymentCheck };
if (require.main === module) {
  try { main(); } catch (error) {
    // Raw subprocess errors and resource payloads may contain credentials: never forward them.
    const code = error instanceof PreflightError ? error.code : 'preflight_unclassified';
    console.error(JSON.stringify({ schemaVersion: 1, status: 'blocked', code })); process.exitCode = 1;
  }
}
