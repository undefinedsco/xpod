export type SolidFsMaterializationClass = 'byline-local' | 'placeholder-r2' | 'hydrated-r2';
export type SolidFsParserCoverageStatus = 'none' | 'partial' | 'complete' | 'stale' | 'failed';

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

export interface ParserCoverageNoteInput {
  subject: string;
  about: string;
  parserKind: string;
  parserVersion: string;
  coverageUnit: 'page' | 'line' | 'byte' | 'section' | 'symbol' | 'rdf-resource';
  coveredRange: string;
  parsedUnits: number;
  totalUnits?: number;
  status: SolidFsParserCoverageStatus;
}

const PREFIXES = '@prefix dct: <http://purl.org/dc/terms/> .\n@prefix sioc: <http://rdfs.org/sioc/ns#> .\n@prefix udfs: <https://vocab.undefineds.co/udfs#> .\n\n';

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
    lines.push(`  udfs:byteSize ${input.byteSize} ;`);
  }
  if (input.contentHash) {
    lines.push(`  udfs:contentHash ${literal(input.contentHash)} ;`);
  }
  lines.push(`  udfs:materializationClass ${literal(input.materializationClass)} .`);
  return `${PREFIXES}${lines.join('\n')}\n`;
}

export function buildParserCoverageNote(input: ParserCoverageNoteInput): string {
  const lines = [
    `${term(input.subject)} a udfs:Note ;`,
    `  sioc:about ${term(input.about)} ;`,
    '  dct:title "Parser coverage" ;',
    `  dct:description ${literal(`Parsed ${input.coveredRange}.`)} ;`,
    '  udfs:noteKind "parser-coverage" ;',
    `  udfs:parserKind ${literal(input.parserKind)} ;`,
    `  udfs:parserVersion ${literal(input.parserVersion)} ;`,
    `  udfs:coverageUnit ${literal(input.coverageUnit)} ;`,
    `  udfs:coveredRange ${literal(input.coveredRange)} ;`,
    `  udfs:parsedUnits ${input.parsedUnits} ;`,
  ];
  if (input.totalUnits !== undefined) {
    lines.push(`  udfs:totalUnits ${input.totalUnits} ;`);
  }
  lines.push(`  udfs:status ${literal(input.status)} .`);
  return `${PREFIXES}${lines.join('\n')}\n`;
}

function term(value: string): string {
  return value.startsWith('<') || value.startsWith('_:') ? value : `<${value}>`;
}

function literal(value: string): string {
  return JSON.stringify(value) ?? '""';
}
