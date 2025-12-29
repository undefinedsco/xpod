/**
 * QuintEngine - Configurable SPARQL engine backed by QuintStore
 * 
 * Store type (SQLite/PostgreSQL) determined by endpoint scheme.
 * 
 * Usage:
 * ```json
 * {
 *   "@type": "QuintEngine",
 *   "endpoint": "postgresql://user:pass@localhost/db"
 * }
 * ```
 */

import type { Bindings, ResultStream } from '@rdfjs/types';
import type { Quad } from '@rdfjs/types';

import type { QuintStore } from '../quint/types';
import { SqliteQuintStore } from '../quint/SqliteQuintStore';
import { PgQuintStore } from '../quint/PgQuintStore';
import { ComunicaQuintEngine, type QueryContext } from './ComunicaQuintEngine';

export interface QuintEngineArgs {
  /**
   * Connection string with scheme prefix:
   * - SQLite: 'sqlite:/path/to/db' or 'sqlite::memory:'
   * - PostgreSQL: 'postgresql://user:pass@host/db' or 'postgres://...'
   */
  endpoint: string;
  
  /**
   * Enable debug logging
   */
  debug?: boolean;
}

/**
 * QuintEngine - Injectable SPARQL engine with configurable backend
 * 
 * This class provides a unified interface for SPARQL queries backed by
 * either SQLite or PostgreSQL QuintStore implementations.
 */
export class QuintEngine {
  private readonly store: QuintStore;
  private readonly engine: ComunicaQuintEngine;
  private readonly storeType: 'sqlite' | 'postgresql';
  private isOpen = false;

  public constructor(args: QuintEngineArgs) {
    const { storeType, connectionString } = this.parseEndpoint(args.endpoint);
    this.storeType = storeType;
    
    // Create appropriate store based on scheme
    if (storeType === 'postgresql') {
      this.store = new PgQuintStore({
        connectionString,
      });
    } else {
      this.store = new SqliteQuintStore({
        path: connectionString,
      });
    }
    
    this.engine = new ComunicaQuintEngine(this.store, {
      debug: args.debug,
    });
  }

  /**
   * Parse endpoint string to extract store type and connection string
   * 
   * Formats:
   * - sqlite:/path/to/db -> SQLite with file path
   * - sqlite::memory: -> SQLite in-memory
   * - postgresql://user:pass@host/db -> PostgreSQL
   * - postgres://user:pass@host/db -> PostgreSQL (alias)
   */
  private parseEndpoint(endpoint: string): { storeType: 'sqlite' | 'postgresql'; connectionString: string } {
    if (endpoint.startsWith('sqlite:')) {
      // sqlite:/path/to/db or sqlite::memory:
      const path = endpoint.slice('sqlite:'.length);
      return { 
        storeType: 'sqlite', 
        connectionString: path || ':memory:',
      };
    }
    
    if (endpoint.startsWith('postgresql://') || endpoint.startsWith('postgres://')) {
      return { 
        storeType: 'postgresql', 
        connectionString: endpoint,
      };
    }
    
    // Default: treat as SQLite file path for backward compatibility
    return { 
      storeType: 'sqlite', 
      connectionString: endpoint,
    };
  }

  /**
   * Open the underlying store connection
   */
  public async open(): Promise<void> {
    if (!this.isOpen) {
      await this.store.open();
      this.isOpen = true;
    }
  }

  /**
   * Close the store connection
   */
  public async close(): Promise<void> {
    if (this.isOpen) {
      await this.store.close();
      this.isOpen = false;
    }
  }

  /**
   * Ensure store is open, auto-open if needed
   */
  private async ensureOpen(): Promise<void> {
    if (!this.isOpen) {
      await this.open();
    }
  }

  /**
   * Execute SELECT query
   */
  public async queryBindings(query: string, context?: QueryContext): Promise<ResultStream<Bindings>> {
    await this.ensureOpen();
    return this.engine.queryBindings(query, context);
  }

  /**
   * Execute ASK query
   */
  public async queryBoolean(query: string, context?: QueryContext): Promise<boolean> {
    await this.ensureOpen();
    return this.engine.queryBoolean(query, context);
  }

  /**
   * Execute CONSTRUCT/DESCRIBE query
   */
  public async queryQuads(query: string, context?: QueryContext): Promise<ResultStream<Quad>> {
    await this.ensureOpen();
    return this.engine.queryQuads(query, context);
  }

  /**
   * Execute UPDATE query (INSERT/DELETE)
   */
  public async queryVoid(query: string, context?: QueryContext): Promise<void> {
    await this.ensureOpen();
    return this.engine.queryVoid(query, context);
  }

  /**
   * Get the underlying QuintStore for direct operations
   */
  public getStore(): QuintStore {
    return this.store;
  }

  /**
   * Get the underlying ComunicaQuintEngine
   */
  public getEngine(): ComunicaQuintEngine {
    return this.engine;
  }

  /**
   * Get the store type
   */
  public getStoreType(): 'sqlite' | 'postgresql' {
    return this.storeType;
  }
}
