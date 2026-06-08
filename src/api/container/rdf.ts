import type { StoreContext } from '../chatkit/store';
import { RdfRunContextRetriever } from '../runs/RdfRunContextRetriever';
import type { RunContextRetriever } from '../runs/RunExecutionBackend';
import { PostgresRdfEngine, type RdfEngineLike } from '../../storage/rdf';
import type { ApiContainerConfig } from './types';

export function createApiRdfEngine(config: ApiContainerConfig): RdfEngineLike | undefined {
  const connectionString = config.sparqlEndpoint;
  if (config.edition !== 'cloud' || !connectionString || !isPostgresConnectionString(connectionString)) {
    return undefined;
  }

  return new PostgresRdfEngine({
    driver: 'pg',
    connectionString,
    rdfAccelerationProfile: 'pg-hot-operators',
    deferPgCustomIndexInitialization: true,
    maintenanceIntervalMs: 0,
    textIndex: {
      driver: 'pg',
      connectionString,
    },
    vectorIndex: {
      driver: 'pg',
      connectionString,
    },
  });
}

export function createApiRunContextRetriever(
  rdfEngine: RdfEngineLike | undefined,
): RunContextRetriever<StoreContext> | undefined {
  if (!rdfEngine) {
    return undefined;
  }

  return new RdfRunContextRetriever({
    rdfEngine,
  });
}

export function isPostgresConnectionString(value: string): boolean {
  return value.startsWith('postgres://') || value.startsWith('postgresql://');
}
