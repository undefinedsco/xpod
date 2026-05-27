const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  '.ttl': 'text/turtle',
  '.jsonld': 'application/ld+json',
  '.nt': 'application/n-triples',
  '.nq': 'application/n-quads',
  '.trig': 'application/trig',
  '.n3': 'text/n3',
  '.rdf': 'application/rdf+xml',
  '.rdfs': 'application/rdf+xml',
  '.owl': 'application/rdf+xml',
};

const LINE_ADDRESSABLE_RDF_TYPES = new Set([
  'text/turtle',
  'application/ld+json',
  'application/n-triples',
  'application/n-quads',
  'application/trig',
  'text/n3',
]);

const SAFE_RDF_TYPES = new Set([
  ...LINE_ADDRESSABLE_RDF_TYPES,
  'application/rdf+xml',
]);

export function normalizeContentType(contentType: string | undefined): string | undefined {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() || undefined;
}

export function rdfContentTypeForPath(filePath: string): string | undefined {
  const pathname = pathnameFromPathOrUrl(filePath).toLowerCase();
  const extension = Object.keys(CONTENT_TYPE_BY_EXTENSION)
    .find((candidate) => pathname.endsWith(candidate));
  return extension ? CONTENT_TYPE_BY_EXTENSION[extension] : undefined;
}

export function isLineAddressableRdfContentType(contentType: string | undefined): boolean {
  const normalized = normalizeContentType(contentType);
  return Boolean(normalized && LINE_ADDRESSABLE_RDF_TYPES.has(normalized));
}

export function isLineAddressableRdfPath(filePath: string): boolean {
  const contentType = rdfContentTypeForPath(filePath);
  return Boolean(contentType && LINE_ADDRESSABLE_RDF_TYPES.has(contentType));
}

export function isLineAddressableRdf(contentType: string | undefined, filePath?: string): boolean {
  return isLineAddressableRdfContentType(contentType)
    || Boolean(filePath && isLineAddressableRdfPath(filePath));
}

export function isRdfDocumentContentType(contentType: string | undefined): boolean {
  const normalized = normalizeContentType(contentType);
  return Boolean(normalized && SAFE_RDF_TYPES.has(normalized));
}

export function isRdfDocumentPath(filePath: string): boolean {
  const contentType = rdfContentTypeForPath(filePath);
  return Boolean(contentType && SAFE_RDF_TYPES.has(contentType));
}

export function isRdfDocument(contentType: string | undefined, filePath?: string): boolean {
  return isRdfDocumentContentType(contentType)
    || Boolean(filePath && isRdfDocumentPath(filePath));
}

export function isSafeRdfDocumentContentType(contentType: string | undefined): boolean {
  return isRdfDocumentContentType(contentType);
}

function pathnameFromPathOrUrl(input: string): string {
  try {
    return new URL(input).pathname;
  } catch {
    return input;
  }
}
