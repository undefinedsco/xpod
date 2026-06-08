export interface RdfSearchSourceFilter {
  source?: string;
  sourcePrefix?: string;
  allowedSources?: string[];
  deniedSources?: string[];
  deniedSourcePrefixes?: string[];
}

export function appendRdfSearchSourceFilters(
  filter: RdfSearchSourceFilter,
  conditions: string[],
  params: unknown[],
  sourceColumn = 'source.source',
): void {
  if (filter.source) {
    conditions.push(`${sourceColumn} = ?`);
    params.push(filter.source);
  }
  if (filter.sourcePrefix) {
    conditions.push(`${sourceColumn} >= ? AND ${sourceColumn} < ?`);
    params.push(filter.sourcePrefix, `${filter.sourcePrefix}\uffff`);
  }

  const allowedSources = uniqueStrings(filter.allowedSources);
  if (allowedSources) {
    if (allowedSources.length === 0) {
      conditions.push('1 = 0');
    } else {
      conditions.push(`${sourceColumn} IN (${allowedSources.map(() => '?').join(', ')})`);
      params.push(...allowedSources);
    }
  }

  const deniedSources = uniqueStrings(filter.deniedSources);
  if (deniedSources && deniedSources.length > 0) {
    conditions.push(`${sourceColumn} NOT IN (${deniedSources.map(() => '?').join(', ')})`);
    params.push(...deniedSources);
  }

  const deniedPrefixes = uniqueStrings(filter.deniedSourcePrefixes);
  for (const prefix of deniedPrefixes ?? []) {
    conditions.push(`NOT (${sourceColumn} >= ? AND ${sourceColumn} < ?)`);
    params.push(prefix, `${prefix}\uffff`);
  }
}

export function appendPgRdfSearchSourceFilters(
  filter: RdfSearchSourceFilter,
  conditions: string[],
  params: unknown[],
  sourceColumn = 'source.source',
): void {
  const placeholder = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filter.source) {
    conditions.push(`${sourceColumn} = ${placeholder(filter.source)}`);
  }
  if (filter.sourcePrefix) {
    conditions.push(`${sourceColumn} >= ${placeholder(filter.sourcePrefix)} AND ${sourceColumn} < ${placeholder(`${filter.sourcePrefix}\uffff`)}`);
  }

  const allowedSources = uniqueStrings(filter.allowedSources);
  if (allowedSources) {
    if (allowedSources.length === 0) {
      conditions.push('1 = 0');
    } else {
      conditions.push(`${sourceColumn} = ANY(${placeholder(allowedSources)}::text[])`);
    }
  }

  const deniedSources = uniqueStrings(filter.deniedSources);
  if (deniedSources && deniedSources.length > 0) {
    conditions.push(`NOT (${sourceColumn} = ANY(${placeholder(deniedSources)}::text[]))`);
  }

  const deniedPrefixes = uniqueStrings(filter.deniedSourcePrefixes);
  for (const prefix of deniedPrefixes ?? []) {
    conditions.push(`NOT (${sourceColumn} >= ${placeholder(prefix)} AND ${sourceColumn} < ${placeholder(`${prefix}\uffff`)})`);
  }
}

function uniqueStrings(values: string[] | undefined): string[] | undefined {
  if (!values) {
    return undefined;
  }
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}
