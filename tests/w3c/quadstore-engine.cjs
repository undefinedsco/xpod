/**
 * rdf-test-suite adapter for ComunicaOptimizedEngine (quadstore)
 * 
 * Usage:
 *   npx rdf-test-suite tests/w3c/quadstore-engine.cjs \
 *     http://w3c.github.io/rdf-tests/sparql/sparql11/manifest-all.ttl \
 *     -i '{"sparqlAlgebra":true}' \
 *     -c .rdf-test-suite-cache/
 */

const { DataFactory } = require('n3');
const { Quadstore } = require('quadstore');
const { ClassicLevel } = require('classic-level');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Dynamic import for ESM modules
let ComunicaOptimizedEngine;
let enginePromise = null;

async function getEngine() {
  if (!ComunicaOptimizedEngine) {
    const mod = await import('../../dist/storage/sparql/ComunicaOptimizedEngine.js');
    ComunicaOptimizedEngine = mod.ComunicaOptimizedEngine;
  }
  return ComunicaOptimizedEngine;
}

// Shared store instance
let store = null;
let engine = null;
let levelPath = null;

async function initStore() {
  if (store) return { store, engine };
  
  await getEngine();
  
  levelPath = path.join(os.tmpdir(), `w3c-quadstore-${Date.now()}`);
  const level = new ClassicLevel(levelPath);
  
  store = new Quadstore({
    backend: level,
    dataFactory: DataFactory,
  });
  
  await store.open();
  engine = new ComunicaOptimizedEngine(store, { debug: false });
  
  return { store, engine };
}

async function clearStore() {
  if (!store) return;
  const result = await store.get({});
  if (result.items.length > 0) {
    await store.multiDel(result.items);
  }
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
    const { engine } = await initStore();
    
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
    const { engine } = await initStore();
    
    if (data && data.length > 0) {
      await clearStore();
      await store.multiPut(data);
    }
    
    await engine.queryVoid(updateString);
    
    // Return current store contents
    const result = await store.get({});
    return result.items;
  },
  
  release: async function() {
    if (store) {
      await store.close();
      store = null;
      engine = null;
      
      if (levelPath && fs.existsSync(levelPath)) {
        fs.rmSync(levelPath, { recursive: true, force: true });
      }
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
