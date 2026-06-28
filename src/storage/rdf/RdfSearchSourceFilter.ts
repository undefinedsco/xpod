export interface RdfSearchSourceFilter {
  source?: string;
  sourcePrefix?: string;
  localPathPrefix?: string;
  allowedSources?: string[];
  deniedSources?: string[];
  deniedSourcePrefixes?: string[];
}

export function appendRdfSearchSourceFilters(
  filter: RdfSearchSourceFilter,
  conditions: string[],
  params: unknown[],
  sourceColumn = 'source.source',
  localPathColumn = 'source.local_path',
): void {
  if (filter.source) {
    conditions.push(`${sourceColumn} = ?`);
    params.push(filter.source);
  }
  if (filter.sourcePrefix) {
    conditions.push(`${sourceColumn} >= ? AND ${sourceColumn} < ?`);
    params.push(filter.sourcePrefix, `${filter.sourcePrefix}\uffff`);
  }
  if (filter.localPathPrefix) {
    conditions.push(`${localPathColumn} >= ? AND ${localPathColumn} < ?`);
    params.push(filter.localPathPrefix, `${filter.localPathPrefix}\uffff`);
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
  localPathColumn = 'source.local_path',
): void {
  const placeholder = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filter.source) {
    conditions.push(`${sourceColumn} = ${placeholder(filter.source)}`);
  }
  if (filter.sourcePrefix) {
    appendPgPrefixFilter(conditions, placeholder, sourceColumn, filter.sourcePrefix);
  }
  if (filter.localPathPrefix) {
    appendPgPrefixFilter(conditions, placeholder, localPathColumn, filter.localPathPrefix);
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
    conditions.push(`NOT (${pgPrefixCondition(sourceColumn, placeholder(prefix), placeholder(`${prefix}\uffff`), placeholder(prefix))})`);
  }
}

function appendPgPrefixFilter(
  conditions: string[],
  placeholder: (value: unknown) => string,
  column: string,
  prefix: string,
): void {
  conditions.push(pgPrefixCondition(
    column,
    placeholder(prefix),
    placeholder(`${prefix}\uffff`),
    placeholder(prefix),
  ));
}

function pgPrefixCondition(column: string, lower: string, upper: string, exact: string): string {
  return `(${column} COLLATE "C") >= (${lower} COLLATE "C") AND (${column} COLLATE "C") < (${upper} COLLATE "C") AND starts_with(${column}, ${exact})`;
}

function uniqueStrings(values: string[] | undefined): string[] | undefined {
  if (!values) {
    return undefined;
  }
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}
