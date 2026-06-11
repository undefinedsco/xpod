import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import { buildModelTypeIndexEntries } from '../../src/provision/model-type-index';
import {
  getConfiguredAccount,
  loginWithClientCredentials,
  setupAccount,
} from './helpers/solidAccount';

const RUN = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
const suite = RUN ? describe : describe.skip;

const SOLID = 'http://www.w3.org/ns/solid/terms#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const BASE = (process.env.CSS_BASE_URL || 'http://localhost:5739').replace(/\/$/, '');

function parseTurtle(body: string, baseIRI: string) {
  return new Parser({ baseIRI }).parse(body);
}

function objectValues(quads: ReturnType<typeof parseTurtle>, subject: string, predicate: string): string[] {
  return quads
    .filter((quad) => quad.subject.value === subject && quad.predicate.value === predicate)
    .map((quad) => quad.object.value);
}

suite('Model TypeIndex data interop', () => {
  it('discovers every @undefineds.co/models registration through WebID profile and private TypeIndex RDF', async() => {
    const account = await setupAccount(BASE, 'models-ti') ?? getConfiguredAccount(BASE);
    expect(account).not.toBeNull();

    const profileUrl = account!.webId.split('#')[0];
    const profileResponse = await fetch(profileUrl, {
      headers: { Accept: 'text/turtle' },
    });
    expect(profileResponse.status).toBe(200);

    const profileQuads = parseTurtle(await profileResponse.text(), profileUrl);
    const typeIndexUrl = objectValues(profileQuads, account!.webId, `${SOLID}privateTypeIndex`)[0];
    const storageUrl = objectValues(profileQuads, account!.webId, `${SOLID}storage`)[0];
    expect(typeIndexUrl).toBe(`${account!.podUrl}settings/privateTypeIndex.ttl`);
    expect(storageUrl).toBe(account!.podUrl);

    const session = await loginWithClientCredentials(account!);
    const typeIndexResponse = await session.fetch(typeIndexUrl, {
      headers: { Accept: 'text/turtle' },
    });
    expect(typeIndexResponse.status).toBe(200);

    const typeIndexQuads = parseTurtle(await typeIndexResponse.text(), typeIndexUrl);
    expect(objectValues(typeIndexQuads, typeIndexUrl, `${RDF}type`)).toContain(`${SOLID}TypeIndex`);

    const registrations = new Map<string, { forClass?: string; instanceContainer?: string }>();
    for (const quad of typeIndexQuads) {
      if (quad.predicate.value === `${RDF}type` && quad.object.value === `${SOLID}TypeRegistration`) {
        registrations.set(quad.subject.value, registrations.get(quad.subject.value) ?? {});
      }
      if (quad.predicate.value === `${SOLID}forClass`) {
        registrations.set(quad.subject.value, {
          ...registrations.get(quad.subject.value),
          forClass: quad.object.value,
        });
      }
      if (quad.predicate.value === `${SOLID}instanceContainer`) {
        registrations.set(quad.subject.value, {
          ...registrations.get(quad.subject.value),
          instanceContainer: quad.object.value,
        });
      }
    }

    const actualTargets = new Set(Array.from(registrations.values()).map((entry) => `${entry.forClass}\n${entry.instanceContainer}`));
    const expectedEntries = buildModelTypeIndexEntries(account!.podUrl);
    const expectedTargets = new Set(expectedEntries.map((entry) => `${entry.rdfClass}\n${entry.instanceContainer}`));

    expect(registrations.size).toBe(expectedEntries.length);
    expect(actualTargets).toEqual(expectedTargets);
  }, 60000);
});
