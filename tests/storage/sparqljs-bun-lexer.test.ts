import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Parser } from 'sparqljs';

describe('SPARQL.js numeric lexer semantics and Bun performance', () => {
  it.each([
    [ '1e0', 'double', '1e0' ], [ '+1e2', 'double', '1e2' ], [ '-1E-3', 'double', '-1e-3' ],
    [ '.5e2', 'double', '.5e2' ], [ '+.5E+2', 'double', '.5e+2' ], [ '-.5e-2', 'double', '-.5e-2' ],
    [ '1.e2', 'double', '1.e2' ], [ '+12.5e2', 'double', '12.5e2' ], [ '-12.5E2', 'double', '-12.5e2' ],
    [ '12', 'integer', '12' ], [ '+12', 'integer', '12' ], [ '-12', 'integer', '-12' ],
    [ '.5', 'decimal', '.5' ], [ '+.5', 'decimal', '.5' ], [ '-.5', 'decimal', '-.5' ],
  ])('retains the normalized value and datatype of %s', (number, datatype, expected) => {
    const ast = new Parser().parse(`INSERT DATA { <urn:subject> <urn:number> ${number} }`) as any;
    const value = ast.updates[0].insert[0].triples[0].object;
    expect(value.value).toBe(expected);
    expect(value.datatype.value).toBe(`http://www.w3.org/2001/XMLSchema#${datatype}`);
  });

  it.each([ '1e', '+1e+', '-.5e-', '1.2.3e4' ])('rejects malformed numeric input %s', number => {
    expect(() => new Parser().parse(`INSERT DATA { <urn:s> <urn:p> ${number} }`)).toThrow();
  });

  it('parses a large shared-document update in an actual Bun process within a bounded budget', () => {
    const triples: string[] = [];
    for (let i = 0; i < 100; i++) {
      const subject = `<https://lexer.invalid/pod/2026/10/02/messages.ttl#msg-${i}>`;
      const body = `message ${i}: "quotes" 中文 😀 \\ slash`;
      triples.push(`${subject} <urn:content> ${JSON.stringify(body)} .`);
      triples.push(`${subject} <urn:metadata> ${JSON.stringify(JSON.stringify({
        event: { id: i, content: { body }, attributes: Array.from({ length: 30 }, (_, n) => `value-${i}-${n}`) },
      }))} .`);
      for (let n = 0; n < 10; n++) triples.push(`${subject} <urn:field-${n}> "value-${i}-${n}" .`);
      triples.push(`${subject} <urn:created> "2026-10-02T00:01:00.001Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .`);
    }
    const input = `INSERT DATA {\n${triples.join('\n')}\n}`;
    const child = spawnSync('bun', [ '--no-env-file', path.resolve('tests/helpers/sparqlBunParserProbe.cjs') ], {
      input, encoding: 'utf8', timeout: 8_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim());
    expect(result.runtime).toBeTruthy();
    expect(result.triples).toBe(1300);
    expect(result.elapsedMs).toBeLessThan(5_000);
  }, 10_000);
});
