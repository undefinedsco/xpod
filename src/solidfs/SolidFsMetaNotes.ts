export type SolidFsMaterializationClass = 'byline-local' | 'placeholder-r2' | 'hydrated-r2';
export type SolidFsReaderCoverageStatus = 'none' | 'partial' | 'complete' | 'stale' | 'failed';

export interface FileMetadataNoteInput {
  subject: string;
  about: string;
  title: string;
  description: string;
  mediaType?: string;
  byteSize?: number;
  contentHash?: string;
  materializationClass: SolidFsMaterializationClass;
}

export interface ReaderCoverageNoteInput {
  subject: string;
  about: string;
  readerKind: string;
  readerVersion: string;
  coverageUnit: 'page' | 'line' | 'byte' | 'section' | 'symbol' | 'rdf-resource';
  coveredRange: string;
  readUnits: number;
  totalUnits?: number;
  status: SolidFsReaderCoverageStatus;
}

const PREFIXES = '@prefix dct: <http://purl.org/dc/terms/> .\n@prefix sioc: <http://rdfs.org/sioc/ns#> .\n@prefix udfs: <https://vocab.undefineds.co/udfs#> .\n\n';
const BLANK_NODE_LABEL = /^_:[A-Za-z][A-Za-z0-9_-]*$/;
const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const IRIREF_REQUIRES_ENCODING = /[\u0000-\u0020<>"{}|^`\\]/;
const IRIREF_UNSAFE_CHARS = /[<>"{}|^`\\]/g;
const INVALID_PERCENT_ESCAPE = /%(?![0-9A-Fa-f]{2})/;

export function buildFileMetadataNote(input: FileMetadataNoteInput): string {
  const lines = [
    `${term(input.subject)} a udfs:Note ;`,
    `  sioc:about ${term(input.about)} ;`,
    `  dct:title ${literal(input.title)} ;`,
    `  dct:description ${literal(input.description)} ;`,
    '  udfs:noteKind "file-metadata" ;',
  ];
  if (input.mediaType) {
    lines.push(`  udfs:mediaType ${literal(input.mediaType)} ;`);
  }
  if (input.byteSize !== undefined) {
    lines.push(`  udfs:byteSize ${nonNegativeIntegerLiteral('byteSize', input.byteSize)} ;`);
  }
  if (input.contentHash) {
    lines.push(`  udfs:contentHash ${literal(input.contentHash)} ;`);
  }
  lines.push(`  udfs:materializationClass ${literal(input.materializationClass)} .`);
  return `${PREFIXES}${lines.join('\n')}\n`;
}

export function buildReaderCoverageNote(input: ReaderCoverageNoteInput): string {
  const lines = [
    `${term(input.subject)} a udfs:Note ;`,
    `  sioc:about ${term(input.about)} ;`,
    '  dct:title "Reader coverage" ;',
    `  dct:description ${literal(`Read ${input.coveredRange}.`)} ;`,
    '  udfs:noteKind "reader-coverage" ;',
    `  udfs:readerKind ${literal(input.readerKind)} ;`,
    `  udfs:readerVersion ${literal(input.readerVersion)} ;`,
    `  udfs:coverageUnit ${literal(input.coverageUnit)} ;`,
    `  udfs:coveredRange ${literal(input.coveredRange)} ;`,
    `  udfs:readUnits ${nonNegativeIntegerLiteral('readUnits', input.readUnits)} ;`,
  ];
  if (input.totalUnits !== undefined) {
    lines.push(`  udfs:totalUnits ${nonNegativeIntegerLiteral('totalUnits', input.totalUnits)} ;`);
  }
  lines.push(`  udfs:status ${literal(input.status)} .`);
  return `${PREFIXES}${lines.join('\n')}\n`;
}

function term(value: string): string {
  if (value.startsWith('<')) {
    if (!value.endsWith('>')) {
      throw new Error(`Invalid Turtle IRI term: ${value}`);
    }
    const innerValue = value.slice(1, -1);
    if (!isLegalIriRef(innerValue)) {
      throw new Error(`Invalid Turtle IRI term: ${value}`);
    }
    return `<${innerValue}>`;
  }

  if (value.startsWith('_:')) {
    if (!BLANK_NODE_LABEL.test(value)) {
      throw new Error(`Invalid Turtle blank node label: ${value}`);
    }
    return value;
  }

  if (ABSOLUTE_IRI.test(value) && isLegalIriRef(value)) {
    return `<${value}>`;
  }

  return `<${encodeIriRef(value)}>`;
}

function literal(value: string): string {
  return JSON.stringify(value) ?? '""';
}

function nonNegativeIntegerLiteral(field: string, value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
  return String(value);
}

function encodeIriRef(value: string): string {
  if (value.includes('>')) {
    throw new Error(`Invalid Turtle IRI term: ${value}`);
  }

  let encoded: string;
  try {
    encoded = encodeURI(value).replace(IRIREF_UNSAFE_CHARS, encodeAsciiChar);
  } catch {
    throw new Error(`Invalid Turtle IRI term: ${value}`);
  }

  if (encoded.includes('>')) {
    throw new Error(`Invalid Turtle IRI term: ${value}`);
  }
  return encoded;
}

function isLegalIriRef(value: string): boolean {
  return !IRIREF_REQUIRES_ENCODING.test(value) && !INVALID_PERCENT_ESCAPE.test(value);
}

function encodeAsciiChar(char: string): string {
  return `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
}
