import {
  PostgresRdfEngine,
  type RdfEngineLike,
  type RdfEngineStorageStats,
  type RdfPgAccelerationProfile,
  type RdfStorageStatsOptions,
} from '../../storage/rdf';

export interface RdfStorageStatsServiceOptions {
  edition: 'cloud' | 'local';
  sparqlEndpoint?: string;
  rdfAccelerationProfile?: RdfPgAccelerationProfile;
  rdfEngine?: Pick<RdfEngineLike, 'storageStats'>;
}

export type RdfStorageStatsSnapshot =
  | {
      available: true;
      engine: 'postgres-rdf';
      generatedAt: string;
      stats: RdfEngineStorageStats;
    }
  | {
      available: false;
      engine: 'postgres-rdf' | 'unsupported';
      generatedAt: string;
      reason: 'not-cloud' | 'missing-sparql-endpoint' | 'unsupported-sparql-endpoint';
    };

export class RdfStorageStatsService {
  public constructor(private readonly options: RdfStorageStatsServiceOptions) {}

  public async snapshot(options: RdfStorageStatsOptions = {}): Promise<RdfStorageStatsSnapshot> {
    const generatedAt = new Date().toISOString();
    if (this.options.edition !== 'cloud') {
      return {
        available: false,
        engine: 'unsupported',
        generatedAt,
        reason: 'not-cloud',
      };
    }

    if (this.options.rdfEngine) {
      return {
        available: true,
        engine: 'postgres-rdf',
        generatedAt,
        stats: await this.options.rdfEngine.storageStats(options),
      };
    }

    const connectionString = this.options.sparqlEndpoint;
    if (!connectionString) {
      return {
        available: false,
        engine: 'postgres-rdf',
        generatedAt,
        reason: 'missing-sparql-endpoint',
      };
    }
    if (!isPostgresConnectionString(connectionString)) {
      return {
        available: false,
        engine: 'unsupported',
        generatedAt,
        reason: 'unsupported-sparql-endpoint',
      };
    }

    const engine = new PostgresRdfEngine({
      driver: 'pg',
      connectionString,
      rdfAccelerationProfile: this.options.rdfAccelerationProfile ?? 'pg-hot-operators',
      deferPgCustomIndexInitialization: true,
      maintenanceIntervalMs: 0,
    });
    try {
      return {
        available: true,
        engine: 'postgres-rdf',
        generatedAt,
        stats: await engine.storageStats(options),
      };
    } finally {
      await engine.close();
    }
  }
}

function isPostgresConnectionString(value: string): boolean {
  return value.startsWith('postgres://') || value.startsWith('postgresql://');
}
