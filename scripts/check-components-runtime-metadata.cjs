#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const componentsRootPath = path.join(repoRoot, 'dist', 'components', 'components.jsonld');
const localPrefix = 'undefineds:';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function localImportToPath(importId) {
  if (typeof importId !== 'string' || !importId.startsWith(localPrefix)) {
    return undefined;
  }
  return path.join(repoRoot, importId.slice(localPrefix.length));
}

function normalizeArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [ value ];
}

function main() {
  const root = readJson(componentsRootPath);
  const imports = normalizeArray(root.import);
  const componentIds = new Set();
  const importedDocuments = [];
  const failures = [];

  for (const importId of imports) {
    const importPath = localImportToPath(importId);
    if (!importPath) {
      continue;
    }
    if (!fs.existsSync(importPath)) {
      failures.push(`missing import file: ${importId}`);
      continue;
    }

    const document = readJson(importPath);
    importedDocuments.push({ importId, document });
    for (const component of normalizeArray(document.components)) {
      if (typeof component['@id'] === 'string') {
        componentIds.add(component['@id']);
      }
    }
  }

  for (const { importId, document } of importedDocuments) {
    for (const component of normalizeArray(document.components)) {
      for (const target of normalizeArray(component.extends)) {
        if (typeof target === 'string' &&
          target.startsWith(localPrefix) &&
          !componentIds.has(target)) {
          failures.push(`${component['@id']} extends ${target}, but ${target} is not imported by dist/components/components.jsonld (${importId})`);
        }
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`Components runtime metadata is inconsistent:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  }

  console.log(`[components-check] ok: ${componentIds.size} imported components`);
}

main();
