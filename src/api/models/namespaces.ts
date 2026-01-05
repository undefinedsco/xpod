// Copied from linx/packages/models/src/namespaces.ts
// TODO: Centralize this in a shared package (@udfs/vocab or @linx/models)

type NamespaceObject = ((term: string) => string) & {
  prefix: string
  uri: string
  NAMESPACE: string
  term: (name: string) => string
} & Record<string, string>

const ABSOLUTE_IRI = /^[a-zA-Z][a-zA-Z\d+.-]*:/

const createNamespace = (prefix: string, baseUri: string, terms: Record<string, string>): NamespaceObject => {
  const builder = ((term: string) =>
    ABSOLUTE_IRI.test(term) ? term : `${baseUri}${term}`) as NamespaceObject
  builder.prefix = prefix
  builder.uri = baseUri
  builder.NAMESPACE = baseUri
  builder.term = (name: string) => builder(name)
  Object.entries(terms).forEach(([key, local]) => {
    Object.defineProperty(builder, key, {
      value: builder(local),
      enumerable: true,
    })
  })
  return builder
}

export const DCTerms = createNamespace('dc', 'http://purl.org/dc/terms/', {
  modified: 'modified',
  created: 'created',
})

export const LINQ = createNamespace('linx', 'https://linx.ai/ns#', {
  provider: 'provider',
  status: 'status',
  apiKey: 'apiKey',
  baseUrl: 'baseUrl',
  proxy: 'proxy',
  aiModels: 'aiModels',
  ModelProvider: 'ModelProvider',
})
