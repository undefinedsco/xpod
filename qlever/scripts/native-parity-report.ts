export const nativeParityReportEngineIds = ['native-qlever', 'pg-qlever', 'rdf3x'] as const;

export type NativeParityReportEngineId = (typeof nativeParityReportEngineIds)[number];

export type NativeParityReport = {
  queries: { id: string }[];
  results: {
    engineId: NativeParityReportEngineId;
    pgStages?: unknown[];
    queryId: string;
    status: 'failed' | 'ok';
  }[];
};

export function validateNativeParityReportMatrix(report: NativeParityReport): string[] {
  const errors: string[] = [];
  const declaredQueries = new Set<string>();
  const declaredEngines = new Set<string>(nativeParityReportEngineIds);
  const seenCells = new Set<string>();

  for (const query of report.queries) {
    if (declaredQueries.has(query.id)) {
      errors.push(`duplicate queryId ${query.id}`);
    }
    declaredQueries.add(query.id);
  }

  for (const result of report.results) {
    const cell = `${result.queryId}/${result.engineId}`;

    if (!declaredQueries.has(result.queryId)) {
      errors.push(`undeclared queryId ${result.queryId} for ${cell}`);
    }
    if (!declaredEngines.has(result.engineId)) {
      errors.push(`undeclared engineId ${result.engineId} for ${cell}`);
    }
    if (seenCells.has(cell)) {
      errors.push(`duplicate result for ${cell}`);
    }
    seenCells.add(cell);

    if (result.status === 'ok' && result.engineId === 'pg-qlever' && (!result.pgStages || result.pgStages.length === 0)) {
      errors.push(`missing pgStages for ${cell}`);
    }
  }

  for (const queryId of declaredQueries) {
    for (const engineId of nativeParityReportEngineIds) {
      const cell = `${queryId}/${engineId}`;
      if (!seenCells.has(cell)) {
        errors.push(`missing result for ${cell}`);
      }
    }
  }

  return errors;
}
