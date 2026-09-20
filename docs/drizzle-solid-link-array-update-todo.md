# drizzle-solid link-array update TODO

AI Connections stores the selected model set as `aiProvider.hasModel`, a URI link array.

With `@undefineds.co/drizzle-solid` 0.3.18, `updateById()` can return an updated row while the generated RDF document does not contain the corresponding URI triples. Xpod therefore keeps the ORM update as its primary operation and immediately applies a narrowly scoped, authenticated Solid SPARQL PATCH for only the `hasModel` predicate.

TODO: remove `persistModelSelectionLinks()` from `XpodAiConnectionsPodStore` after the drizzle-solid update builder serializes URI arrays correctly and a real CSS regression proves the persisted triples.

## Upstream reproduction (drizzle-solid 0.3.24, 2026-09-14)

`scripts/migrate-ai-offering-storage.ts --live` had to delete exactly three dangling
`udfs:hasModel` triples from `settings/providers/openai.ttl` and keep the three real ones.
Asking the ORM to state the surviving set does the opposite of a deletion:

```ts
database.updateById(aiProviderResource, 'openai.ttl', { hasModel: [ real1, real2, real3 ] })
```

renders (exact text, captured without executing anything):

```sparql
DELETE { GRAPH <https://pod.example/alice/settings/providers/openai.ttl> { <https://pod.example/alice/settings/providers/openai.ttl> <https://undefineds.co/ns#hasModel> ?old_hasModel_0. } }
WHERE { GRAPH <https://pod.example/alice/settings/providers/openai.ttl> { <https://pod.example/alice/settings/providers/openai.ttl> <https://undefineds.co/ns#hasModel> ?old_hasModel_0. } };
INSERT DATA { GRAPH <https://pod.example/alice/settings/providers/openai.ttl> { <https://pod.example/alice/settings/providers/openai.ttl> <https://undefineds.co/ns#hasModel> "\"https://pod.example/alice/settings/providers/openai.ttl#gpt-5.6-sol\",\"https://pod.example/alice/settings/providers/openai.ttl#gpt-5.6-terra\",\"https://pod.example/alice/settings/providers/openai.ttl#gpt-6-astra\"". } }
```

Two defects in one statement:

1. the `DELETE` template binds the object to a variable, so it removes **every**
   `hasModel` triple of the subject, not only the ones being replaced;
2. the `INSERT` writes **one literal** whose value is the comma-joined, backslash-escaped
   URI list instead of one named-node triple per element.

`INSERT` collapses arrays identically - same builder, same
`parseTermString(formatValue(array))` path:

```sparql
INSERT DATA {
  GRAPH <https://pod.example/alice/settings/providers/openai> {
    <https://pod.example/alice/settings/providers/openai> rdf:type <https://undefineds.co/ns#Provider>;
      <https://undefineds.co/ns#displayName> "OpenAI";
      <https://undefineds.co/ns#hasModel> "\"https://pod.example/alice/settings/providers/openai.ttl#gpt-5.6-sol\",\"…\".
  }
}
```

A single-element array is not a workaround: three sequential updates would each re-run the
same "delete all, insert one literal" statement, so only the last element could survive.

### Observation method

Nothing was written to a Pod to capture this. The statements come from the public build path
of the same builder `updateById()` uses:

```ts
const db = drizzle(authSession, { podUrl, schema: { aiModel, aiProvider, credential }, autoConnect: false, resourcePreparation: 'off' });
db.session.update(aiProviderResource).set({ hasModel }).whereByIri(providerIri).toSPARQL().query;
db.session.insert(aiProviderResource).values({ id: 'openai', displayName: 'OpenAI', hasModel }).toSPARQL().query;
```

`authSession.fetch` was a stub that throws, so no request left the process.
`scripts/migrate-ai-offering-storage.test.ts` locks the update half of this in as
`expect(rendered).toMatch(/hasModel> "\\"/)` plus "no surviving reference appears as a named node".

### Consequence for callers until the builder is fixed

The PATCH above (or the equivalent in `persistModelSelectionLinks()`) is the *whole* write,
not a repair after the ORM call: because the ORM statement leaves a literal `hasModel`
triple behind and a `DELETE/INSERT DATA` of named nodes never removes it, issuing both would
persist garbage that no later correction cleans up. `scripts/migrate-ai-offering-storage.ts`
therefore renders the ORM statement for the report and sends only the PATCH, so that removing
the dangling triples stays the only effect.

### Root cause

`core/sparql/builder/update-builder.js` → `buildUpdatePartsForRecord()` treats an array column
like a scalar: `formatValue()` (in `core/sparql/helpers.js`) returns an *array* of formatted
terms for `dataType === 'array'`, and the builder then hands that array to `parseTermString()`,
which falls back to `{ termType: 'Literal', value: String(value) }` and pushes a single triple.
The `DELETE`/`WHERE` template is built from `{ subject, predicate, ?old }` regardless of the
column's cardinality. `insert-query-builder`/`buildInsertTriples()` has the same
`formatValueOrThrow()` → `parseTermString()` shape.
`UpdateQueryBuilder.fetchReturningRowsBySubjects()` then patches the returned row from the
submitted data (`arrayOverrides`), so `updateById()` reports success for a document that does
not contain the URI triples.

