// Bun-only performance regression. The parent owns and bounds this process.
const { readFileSync } = require('node:fs');
const { Parser } = require('sparqljs');
const input = readFileSync(0, 'utf8');
const started = performance.now();
const parsed = new Parser().parse(input);
console.log(JSON.stringify({
  runtime: Bun.version,
  elapsedMs: performance.now() - started,
  triples: parsed.updates[0].insert[0].triples.length,
}));
