import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DataFactory, Parser } from 'n3';
import { resolveAssetPath } from '@solid/community-server';

import { RdfHandlebarsTemplateEngine } from '../../src/util/templates/RdfHandlebarsTemplateEngine';

const baseUrl = 'https://pod.example/';
const profile = '@css:templates/pod/base/profile/card$.ttl.hbs';
const rdfTemplates = [profile, '@css:templates/pod/wac/.acl.hbs', '@css:templates/pod/wac/README.acl.hbs',
  '@css:templates/pod/wac/profile/card.acl.hbs', '@css:templates/pod/acp/.acr.hbs'];

describe('RDF IRI values in controlled CSS Pod templates', () => {
  it.each(rdfTemplates)('preserves the complete WebID in %s', async (templateFile) => {
    const engine = new RdfHandlebarsTemplateEngine(baseUrl);
    const webId = 'https://ID.example:443/路径/%61lice/card?first=1&second=\'two\'#本人';
    const ttl = await engine.handleSafe({ template: { templateFile }, contents: {
      webId, oidcIssuer: 'https://ID.example:443/issuer/?tenant=a&region=b', base: { path: baseUrl },
    } });
    const graph = new Parser({ baseIRI: baseUrl }).parse(ttl);
    const identities = graph.filter((quad) => [
      'http://xmlns.com/foaf/0.1/primaryTopic', 'http://www.w3.org/ns/auth/acl#agent', 'http://www.w3.org/ns/solid/acp#agent',
    ].includes(quad.predicate.value)).map((quad) => quad.object.value);
    expect(identities).toContain(webId);
    expect([...new Set(identities)].sort()).toEqual((templateFile.endsWith('/acp/.acr.hbs')
      ? [webId, 'http://www.w3.org/ns/solid/acp#PublicAgent'] : [webId]).sort());
    if (templateFile === profile) {
      expect(graph.find((quad) => quad.predicate.value === 'http://www.w3.org/ns/solid/terms#oidcIssuer')?.object.value)
        .toBe('https://ID.example:443/issuer/?tenant=a&region=b');
    }
  });

  const forbidden = [...Array.from({ length: 33 }, (_, index) => String.fromCharCode(index)), ...'< >"{}|^`\\', '\ud800'];
  it.each(forbidden)('rejects Turtle IRIREF forbidden character %j before rendering', async (character) => {
    const engine = new RdfHandlebarsTemplateEngine(baseUrl);
    const webId = `https://id.example/a${character}b#me`;
    await expect(engine.handleSafe({ template: { templateFile: profile }, contents: { webId } })).rejects.toThrow('IRI');
  });

  it.each([undefined, null, ''])('rejects a missing WebID: %j', async (webId) => {
    await expect(new RdfHandlebarsTemplateEngine(baseUrl).handleSafe({
      template: { templateFile: profile }, contents: { webId },
    })).rejects.toThrow('IRI');
  });

  it.each(['relative#me', 'javascript:alert(1)', 'https://user:secret@id.example/card#me'])(
    'rejects invalid WebID URL %j', async (webId) => {
      await expect(new RdfHandlebarsTemplateEngine(baseUrl).handleSafe({
        template: { templateFile: profile }, contents: { webId },
      })).rejects.toThrow('IRI');
    },
  );

  it.each(['', null, undefined])('preserves omission of empty optional IRI values: %j', async (empty) => {
    const engine = new RdfHandlebarsTemplateEngine(baseUrl);
    const contents = { webId: `${baseUrl}card#me`, email: empty, oidcIssuer: empty };
    for (const templateFile of [profile, '@css:templates/pod/wac/.acl.hbs']) {
      const graph = new Parser({ baseIRI: baseUrl }).parse(await engine.handleSafe({ template: { templateFile }, contents }));
      expect(graph.some((quad) => quad.predicate.value.endsWith('oidcIssuer') || quad.object.value.startsWith('mailto:'))).toBe(false);
    }
  });

  it('validates mailto IRI input while preserving legal query separators', async () => {
    const engine = new RdfHandlebarsTemplateEngine(baseUrl);
    const template = { templateFile: '@css:templates/pod/wac/.acl.hbs' };
    const contents = { webId: `${baseUrl}card#me`, email: 'alice@example.test?subject=a&body=b' };
    const graph = new Parser({ baseIRI: baseUrl }).parse(await engine.handleSafe({ template, contents }));
    expect(graph.some((quad) => quad.object.equals(DataFactory.namedNode(`mailto:${contents.email}`)))).toBe(true);
    await expect(engine.handleSafe({ template, contents: { ...contents, email: 'bad@example.test> . <urn:injected>' } }))
      .rejects.toThrow('IRI');
  });

  it('keeps HTML escaping for uncontrolled files even with a matching RDF suffix', async () => {
    const root = await mkdtemp(path.resolve('.test-data/rdf-template-'));
    try {
      const file = path.join(root, 'card$.ttl.hbs');
      await writeFile(file, '<a href="{{webId}}">{{webId}}</a>');
      const rendered = await new RdfHandlebarsTemplateEngine(baseUrl).handleSafe({
        template: { templateFile: file }, contents: { webId: 'https://example.test/?a=1&b=2' },
      });
      expect(rendered).toContain('a&#x3D;1&amp;b&#x3D;2');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps HTML/Markdown template behavior and leaves caller values unchanged', async () => {
    const engine = new RdfHandlebarsTemplateEngine(baseUrl);
    const contents = { webId: 'https://example.test/?a=1&b=2', base: { path: baseUrl } };
    const rendered = await engine.handleSafe({
      template: { templateFile: resolveAssetPath('@css:templates/pod/base/README$.md.hbs') }, contents,
    });
    expect(rendered).toContain('a&#x3D;1&amp;b&#x3D;2');
    expect(contents.webId).toBe('https://example.test/?a=1&b=2');
  });
});
