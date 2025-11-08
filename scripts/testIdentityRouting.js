#!/usr/bin/env node
// Verifies that identity provider resources are routed to the SPARQL store while other internal
// data still hits the file store. This is a quick regression check for configuration drift.
const fs = require('fs');
const path = require('path');

const CONFIGS = [
  { file: 'config/main.json', variant: 'file-only' },
  { file: 'config/main.server.json', variant: 'db-first' },
];

const ROUTER_ID = 'urn:solid-server:default:RouterRule';
const IDP_PREFIX = '^/\\.internal/idp/';
const INTERNAL_PREFIX = '^/\\.internal/';
const SPARQL_STORE = 'urn:solid-server:default:SparqlResourceStore';
const FILE_STORE = 'urn:solid-server:default:FileResourceStore';

function loadConfig(file) {
  const contents = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Failed to parse ${file}: ${error.message}`);
  }
}

function extractRouterRules(config, file) {
  const nodes = config['@graph'];
  if (!Array.isArray(nodes)) {
    throw new Error(`Missing @graph in ${file}`);
  }

  const override = nodes.find((node) => node.overrideInstance?.['@id'] === ROUTER_ID);
  if (!override) {
    throw new Error(`Router override not found in ${file}`);
  }

  const rules = override.overrideParameters?.rules;
  if (!Array.isArray(rules)) {
    throw new Error(`Router override in ${file} does not expose a rules array`);
  }
  return rules;
}

function assertRule(message, condition) {
  if (!condition) {
    throw new Error(`Routing check failed: ${message}`);
  }
}

for (const { file, variant } of CONFIGS) {
  const config = loadConfig(file);
  const rules = extractRouterRules(config, file);

  if (variant === 'db-first') {
    assertRule(
      `${file} must have identity rule targeting SPARQL store first`,
      rules[0]?.regex === IDP_PREFIX && rules[0]?.store?.['@id'] === SPARQL_STORE,
    );

    assertRule(
      `${file} must keep broader internal rule pointed at file store`,
      rules[1]?.regex === INTERNAL_PREFIX && rules[1]?.store?.['@id'] === FILE_STORE,
    );

    assertRule(
      `${file} needs fallback rule to SPARQL store`,
      rules[2]?.regex === '.*' && rules[2]?.store?.['@id'] === SPARQL_STORE,
    );
  } else {
    assertRule(
      `${file} should store all internal data on the file system`,
      rules[0]?.regex === INTERNAL_PREFIX && rules[0]?.store?.['@id'] === FILE_STORE,
    );

    assertRule(
      `${file} needs fallback rule to SPARQL store`,
      rules[1]?.regex === '.*' && rules[1]?.store?.['@id'] === SPARQL_STORE,
    );
  }
}

console.log('Identity routing configuration looks good.');
