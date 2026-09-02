# drizzle-solid link-array update TODO

AI Connections stores the selected model set as `aiProvider.hasModel`, a URI link array.

With `@undefineds.co/drizzle-solid` 0.3.18, `updateById()` can return an updated row while the generated RDF document does not contain the corresponding URI triples. Xpod therefore keeps the ORM update as its primary operation and immediately applies a narrowly scoped, authenticated Solid SPARQL PATCH for only the `hasModel` predicate.

TODO: remove `persistModelSelectionLinks()` from `XpodAiConnectionsPodStore` after the drizzle-solid update builder serializes URI arrays correctly and a real CSS regression proves the persisted triples.
