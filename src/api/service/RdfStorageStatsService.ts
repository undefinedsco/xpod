import {
  PostgresRdfEngine,
  type RdfEngineLike,
  type RdfEngineStorageStats,
  type RdfPgAccelerationProfile,
  type RdfStorageStatsOptions,
} from '../../storage/rdf';
import {
  RdfBenchmarkReportCatalog,
  type RdfBenchmarkReportCatalogSnapshot,
} from './RdfBenchmarkReportCatalog';

export interface RdfStorageStatsServiceOptions {
  edition: 'cloud' | 'local';
  sparqlEndpoint?: string;
  rdfAccelerationProfile?: RdfPgAccelerationProfile;
  rdfEngine?: Pick<RdfEngineLike, 'storageStats'>;
  benchmarkReportCatalog?: Pick<RdfBenchmarkReportCatalog, 'snapshot'>;
  benchmarkReportRoots?: string[];
}

export type RdfStorageStatsSnapshot =
  | {
      available: true;
      engine: 'postgres-rdf';
      generatedAt: string;
      stats: RdfEngineStorageStats;
      benchmarkReports?: RdfBenchmarkReportCatalogSnapshot;
    }
  | {
      available: false;
      engine: 'postgres-rdf' | 'unsupported';
      generatedAt: string;
      reason: 'not-cloud' | 'missing-sparql-endpoint' | 'unsupported-sparql-endpoint';
      benchmarkReports?: RdfBenchmarkReportCatalogSnapshot;
    };

export class RdfStorageStatsService {
  private benchmarkReportCatalog?: Pick<RdfBenchmarkReportCatalog, 'snapshot'>;

  public constructor(private readonly options: RdfStorageStatsServiceOptions) {}

  public async snapshot(options: RdfStorageStatsOptions = {}): Promise<RdfStorageStatsSnapshot> {
    const generatedAt = new Date().toISOString();
    const benchmarkReports = await this.snapshotBenchmarkReports();
    if (this.options.edition !== 'cloud') {
      return {
        available: false,
        engine: 'unsupported',
        generatedAt,
        reason: 'not-cloud',
        benchmarkReports,
      };
    }

    if (this.options.rdfEngine) {
      return {
        available: true,
        engine: 'postgres-rdf',
        generatedAt,
        stats: await this.options.rdfEngine.storageStats(options),
        benchmarkReports,
      };
    }

    const connectionString = this.options.sparqlEndpoint;
    if (!connectionString) {
      return {
        available: false,
        engine: 'postgres-rdf',
        generatedAt,
        reason: 'missing-sparql-endpoint',
        benchmarkReports,
      };
    }
    if (!isPostgresConnectionString(connectionString)) {
      return {
        available: false,
        engine: 'unsupported',
        generatedAt,
        reason: 'unsupported-sparql-endpoint',
        benchmarkReports,
      };
    }

    const engine = new PostgresRdfEngine({
      driver: 'pg',
      connectionString,
      rdfAccelerationProfile: this.options.rdfAccelerationProfile ?? 'pg-hot-operators',
      maintenanceIntervalMs: 0,
    });
    try {
      return {
        available: true,
        engine: 'postgres-rdf',
        generatedAt,
        stats: await engine.storageStats(options),
        benchmarkReports,
      };
    } finally {
      await engine.close();
    }
  }

  private async snapshotBenchmarkReports(): Promise<RdfBenchmarkReportCatalogSnapshot | undefined> {
    try {
      return await this.getBenchmarkReportCatalog().snapshot();
    } catch (error) {
      return {
        roots: [],
        reportCount: 0,
        skippedFiles: 0,
        errors: [{ path: '-', message: error instanceof Error ? error.message : String(error) }],
        reports: [],
      };
    }
  }

  private getBenchmarkReportCatalog(): Pick<RdfBenchmarkReportCatalog, 'snapshot'> {
    if (!this.benchmarkReportCatalog) {
      this.benchmarkReportCatalog = this.options.benchmarkReportCatalog ?? new RdfBenchmarkReportCatalog({
        roots: this.options.benchmarkReportRoots,
      });
    }
    return this.benchmarkReportCatalog;
  }
}

function isPostgresConnectionString(value: string): boolean {
  return value.startsWith('postgres://') || value.startsWith('postgresql://');
}
