import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const bridgeSource = path.join(repoRoot, 'qlever/qlever_adapter/src/XpodQleverBridge.cpp');

describe('QLever bridge parser context', () => {
  it('passes a real EncodedIriManager to upstream parsing so IRI text-search terms do not crash', async () => {
    const source = await readFile(bridgeSource, 'utf8');
    expect(source).toContain('"index/EncodedIriManager.h"');
    expect(source).toContain('EncodedIriManager encoded_iri_manager');
    expect(source).toContain('SparqlParser::parseQuery(&encoded_iri_manager, std::string(query))');
    expect(source).not.toContain('SparqlParser::parseQuery(nullptr, std::string(query))');
  });
});
