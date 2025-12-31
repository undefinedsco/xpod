/**
 * rdf-test-suite adapter for ComunicaQuintEngine (QuintStore)
 * 
 * Usage:
 *   npx rdf-test-suite tests/w3c/quint-engine.cjs \
 *     http://w3c.github.io/rdf-tests/sparql/sparql11/manifest-all.ttl \
 *     -i '{"sparqlAlgebra":true}' \
 *     -c .rdf-test-suite-cache/
 */

const { DataFactory } = require('n3');
const path = require('path');

// Dynamic import for ESM modules
let SqliteQuintStore;
let ComunicaQuintEngine;

async function loadModules() {
  if (!SqliteQuintStore) {
    const quintMod = await import('../../dist/storage/quint/index.js');
    SqliteQuintStore = quintMod.SqliteQuintStore;
    
    const engineMod = await import('../../dist/storage/sparql/ComunicaQuintEngine.js');
    ComunicaQuintEngine = engineMod.ComunicaQuintEngine;
  }
}

// Shared store instance
let store = null;
let engine = null;

async function initStore() {
  if (store) return { store, engine };
  
  await loadModules();
  
  store = new SqliteQuintStore({ path: ':memory:' });
  await store.open();
  engine = new ComunicaQuintEngine(store, { debug: false });
  
  return { store, engine };
}

async function clearStore() {
  if (!store) return;
  await store.clear();
}

module.exports = {
  parse: async function(format, data, baseIRI) {
    const { store } = await initStore();
    await clearStore();
    
    const { Parser } = require('n3');
    const parser = new Parser({ format, baseIRI });
    const quads = parser.parse(data);
    
    if (quads.length > 0) {
      await store.multiPut(quads);
    }
    
    return quads;
  },
  
  query: async function(data, queryString, options) {
    const { store, engine } = await initStore();
    
    // Load data if provided
    if (data && data.length > 0) {
      await clearStore();
      await store.multiPut(data);
    }
    
    // Determine query type
    const queryLower = queryString.trim().toLowerCase();
    
    if (queryLower.startsWith('ask')) {
      const result = await engine.queryBoolean(queryString);
      return result;
    }
    
    if (queryLower.startsWith('construct') || queryLower.startsWith('describe')) {
      const stream = await engine.queryQuads(queryString);
      const quads = await streamToArray(stream);
      return quads;
    }
    
    // SELECT query
    const stream = await engine.queryBindings(queryString);
    const bindings = await streamToArray(stream);
    
    // Convert bindings to expected format
    return bindings.map(binding => {
      const result = {};
      for (const [key, value] of binding) {
        result['?' + key] = value;
      }
      return result;
    });
  },
  
  update: async function(data, updateString) {
    const { store, engine } = await initStore();
    
    if (data && data.length > 0) {
      await clearStore();
      await store.multiPut(data);
    }
    
    await engine.queryVoid(updateString);
    
    // Return current store contents
    const quads = await store.get({});
    return quads;
  },
  
  release: async function() {
    if (store) {
      await store.close();
      store = null;
      engine = null;
    }
  }
};

async function streamToArray(stream) {
  if (typeof stream.toArray === 'function') {
    return stream.toArray();
  }
  
  return new Promise((resolve, reject) => {
    const results = [];
    stream.on('data', item => results.push(item));
    stream.on('end', () => resolve(results));
    stream.on('error', reject);
  });
}
