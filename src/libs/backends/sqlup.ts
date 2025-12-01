import path from 'path';
import fs from 'fs';
import { getLoggerFor, Logger } from '@solid/community-server';
import { IManifest, supports } from 'level-supports';
import {
  NodeCallback,
  AbstractLevel,
  AbstractOpenOptions,
  AbstractGetOptions,
  AbstractPutOptions,
  AbstractDelOptions,
  AbstractGetManyOptions,
  AbstractDatabaseOptions,
  AbstractBatchOperation,
  AbstractBatchOptions,
  AbstractIteratorOptions,
  AbstractClearOptions,
  AbstractIterator,
  AbstractSeekOptions,
} from 'abstract-level';
import knex, { Knex } from 'knex';


export const MANIFEST: IManifest = supports({
  snapshots: false,
  permanence: true,
  seek: true,
  deferredOpen: true,
  createIfMissing: true,
  errorIfExists: false,
  streams: false,
  encodings: {
    'view': true,
    'buffer': true
  },
});

type TFormat = Buffer | Uint8Array;

interface SQLUpDatabaseOptions<K = string, V = string> extends AbstractDatabaseOptions<K, V> {
  url: string;
  tableName: string;
}

interface PendingBatchItem {
  tableName: string;
  operations: AbstractBatchOperation<any, any, any>[];
  resolve: () => void;
  reject: (err: Error) => void;
}

// Global shared state per database URL
interface DbSharedState {
  knex: Knex;
  isSqlite: boolean;
  refCount: number;
  pendingBatches: PendingBatchItem[];
  batchScheduled: boolean;
  txActive?: boolean;
}

const dbSharedStates = new Map<string, DbSharedState>();

function getOrCreateSharedState(url: string): DbSharedState | undefined {
  return dbSharedStates.get(url);
}

async function initSharedState(url: string, format: 'buffer' | 'view' | 'utf8'): Promise<DbSharedState> {
  let state = dbSharedStates.get(url);
  if (state) {
    state.refCount++;
    return state;
  }

  const parsedUrl = new URL(url);
  const isSqlite = parsedUrl.protocol === 'sqlite:';
  let db: Knex;

  if (isSqlite) {
    const filename = url.replace('sqlite:', '');
    const directory = path.dirname(filename);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }
    db = knex({
      client: 'sqlite3',
      connection: { filename },
      useNullAsDefault: true,
    });
  } else if (parsedUrl.protocol === 'postgresql:') {
    db = knex({
      client: 'pg',
      connection: url,
      pool: { min: 2, max: 10 },
    });
  } else if (parsedUrl.protocol === 'mysql:') {
    db = knex({
      client: 'mysql2',
      connection: url,
      pool: { min: 2, max: 10 },
    });
  } else {
    throw new Error(`Unsupported database protocol: ${parsedUrl.protocol}`);
  }

  state = {
    knex: db,
    isSqlite,
    refCount: 1,
    pendingBatches: [],
    batchScheduled: false,
  };
  dbSharedStates.set(url, state);
  return state;
}

async function releaseSharedState(url: string): Promise<void> {
  const state = dbSharedStates.get(url);
  if (!state) return;

  state.refCount--;
  if (state.refCount <= 0) {
    dbSharedStates.delete(url);
    await state.knex.destroy();
  }
}

async function flushSharedBatches(url: string): Promise<void> {
  const state = dbSharedStates.get(url);
  if (!state) return;

  const batches = state.pendingBatches;
  state.pendingBatches = [];
  state.batchScheduled = false;

  if (batches.length === 0) return;

  // Group operations by table
  const opsByTable = new Map<string, { key: any; value?: any; type: 'put' | 'del' }[]>();
  for (const batch of batches) {
    let ops = opsByTable.get(batch.tableName);
    if (!ops) {
      ops = [];
      opsByTable.set(batch.tableName, ops);
    }
    for (const op of batch.operations) {
      ops.push({ key: op.key, value: (op as any).value, type: op.type });
    }
  }

  try {
    const applyOps = async (runner: Knex | Knex.Transaction): Promise<void> => {
      for (const [tableName, ops] of opsByTable) {
        const finalState = new Map<string, { key: any; value?: any; type: 'put' | 'del' }>();
        const allKeys = new Set<any>();

        for (const op of ops) {
          const mapKey = Buffer.isBuffer(op.key) ? op.key.toString('hex') : String(op.key);
          finalState.set(mapKey, op);
          allKeys.add(op.key);
        }

        const keysToDelete = Array.from(allKeys);
        if (keysToDelete.length > 0) {
          await runner.delete().from(tableName).whereIn('key', keysToDelete);
        }

        const putsToInsert = Array.from(finalState.values())
          .filter((op) => op.type === 'put')
          .map((op) => ({ key: op.key, value: op.value }));

        if (putsToInsert.length > 0) {
          await runner.insert(putsToInsert).into(tableName).onConflict('key').merge();
        }
      }
    };

    if (state.isSqlite || state.txActive) {
      // SQLite rejects nested transactions; if a higher layer already owns a transaction (txActive),
      // also skip opening a nested one and execute sequentially on the shared connection.
      await applyOps(state.knex);
    } else {
      state.txActive = true;
      try {
        await state.knex.transaction(async (trx) => applyOps(trx));
      } finally {
        state.txActive = false;
      }
    }
    for (const batch of batches) {
      batch.resolve();
    }
  } catch (err: any) {
    for (const batch of batches) {
      batch.reject(err);
    }
  }
}

export class SQLUp<T extends TFormat, K = string, V = string> extends AbstractLevel<T, K, V> {
  private readonly logger = getLoggerFor(this);
  private readonly url: string;
  private readonly tableName: string;
  public readonly format: 'buffer' | 'view' | 'utf8';

  constructor(options: SQLUpDatabaseOptions<K, V>, manifest: IManifest = MANIFEST) {
    super(manifest, options);
    this.url = options.url;
    this.tableName = options.tableName;
    this.format = this.keyEncoding().format;
    this.logger.debug(`SQLUp constructor: ${this.tableName} format: ${this.format}`);
  }

  private get shared(): DbSharedState {
    const state = getOrCreateSharedState(this.url);
    if (!state) {
      throw new Error(`Database not opened: ${this.url}`);
    }
    return state;
  }

  private get db(): Knex {
    return this.shared.knex;
  }

  async _open(options: AbstractOpenOptions, callback: NodeCallback<void>) {
    this.logger.info(`Opening database at ${this.url}, table: ${this.tableName}`);
    try {
      const state = await initSharedState(this.url, this.format);

      const exists = await state.knex.schema.hasTable(this.tableName);
      if (!exists) {
        try {
          await state.knex.schema.createTable(this.tableName, (table) => {
            table.increments('id').primary();
            if (this.format === 'utf8') {
              table.text('key').unique();
              table.text('value');
            } else {
              table.specificType('key', 'BLOB').unique();
              table.specificType('value', 'BLOB');
            }
          });
        } catch (error: any) {
          if (!/already exists/i.test(String(error?.message))) {
            throw error;
          }
        }
      }
      this.logger.info(`Database ${this.tableName} opened`);
      callback(null);
    } catch (err: any) {
      callback(err);
    }
  }

  async _close(callback: NodeCallback<void>) {
    try {
      await releaseSharedState(this.url);
      callback(null);
    } catch (err: any) {
      callback(err);
    }
  }

  async _get(key: T, options: AbstractGetOptions<K, V>, callback: NodeCallback<T>) {
    try {
      const [row] = await this.db.select('value').from(this.tableName).where('key', key);
      callback(null, row?.value);
    } catch (err: any) {
      callback(err);
    }
  }

  async _getMany(keys: T[], options: AbstractGetManyOptions<K, V>, callback: NodeCallback<T[]>) {
    try {
      const rows = await this.db.select('value').from(this.tableName).whereIn('key', keys);
      callback(null, rows.map((row) => row.value));
    } catch (err: any) {
      callback(err);
    }
  }

  async _put(key: T, value: T, options: AbstractPutOptions<K, V>, callback: NodeCallback<void>) {
    try {
      await this.db.delete().from(this.tableName).where('key', key);
      await this.db.insert({ key, value }).into(this.tableName);
      callback(null);
    } catch (err: any) {
      callback(err);
    }
  }

  async _del(key: T, options: AbstractDelOptions<K>, callback: NodeCallback<void>) {
    try {
      await this.db.delete().from(this.tableName).where('key', key);
      callback(null);
    } catch (err: any) {
      callback(err);
    }
  }

  async _batch(
    operations: AbstractBatchOperation<typeof this, T, T>[],
    options: AbstractBatchOptions<K, V>,
    callback: NodeCallback<void>
  ) {
    const state = this.shared;
    const pending = new Promise<void>((resolve, reject) => {
      state.pendingBatches.push({
        tableName: this.tableName,
        operations,
        resolve,
        reject,
      });
    });

    if (!state.batchScheduled) {
      state.batchScheduled = true;
      queueMicrotask(() => flushSharedBatches(this.url));
    }

    try {
      await pending;
      callback(null);
    } catch (err: any) {
      callback(err);
    }
  }

  _sublevel(name: string) {
    return new SQLUp({
      url: this.url,
      tableName: `${this.tableName}_${name}`,
    });
  }

  _iterator(options: AbstractIteratorOptions<K, V>): SQLUpIterator<T, K, V> {
    return new SQLUpIterator(this, options);
  }

  async _clear(options: AbstractClearOptions<K>, callback: NodeCallback<void>) {
    try {
      await this.db.delete().from(this.tableName);
      callback(null);
    } catch (err: any) {
      callback(err);
    }
  }

  getKnex(): Knex {
    return this.db;
  }

  getTableName(): string {
    return this.tableName;
  }
}

class SQLUpIterator<T extends TFormat, K, V> extends AbstractIterator<SQLUp<T, K, V>, K, V> {
  private logger: Logger;
  private options: AbstractIteratorOptions<K, V>;
  private knex: Knex;
  private tableName: string;
  private stream: AsyncGenerator<[T, T]>;
  private done: boolean = false;

  constructor(db: SQLUp<T, K, V>, options: AbstractIteratorOptions<K, V>) {
    super(db, options);
    this.logger = getLoggerFor(`${this.constructor.name}-${this.getUniqueId()}`);
    this.options = options;
    this.knex = db.getKnex();
    this.tableName = db.getTableName();
    this.logger.debug(`constructor: ${this.tableName}`);
    this.stream = this.createStream();
  }

  private getUniqueId(): string {
    return Math.random().toString(36).substr(2, 9);
  }

  private async *createStream(): AsyncGenerator<[T, T]> {
    const keyEncoding = this.db.keyEncoding();
    let query = this.knex.select('key', 'value').from(this.tableName);
    if (this.options.gt) {
      query = query.where('key', '>', keyEncoding.encode(this.options.gt));
    } else if (this.options.gte) {
      query = query.where('key', '>=', keyEncoding.encode(this.options.gte));
    }
    if (this.options.lt) {
      query = query.where('key', '<', keyEncoding.encode(this.options.lt));
    } else if (this.options.lte) {
      query = query.where('key', '<=', keyEncoding.encode(this.options.lte));
    }
    if (this.options.reverse) {
      query = query.orderBy('key', 'desc');
    } else {
      query = query.orderBy('key', 'asc');
    }

    const start = Date.now();
    let cnt = 0;
    try {
      const stream = query.stream();
      for await (const row of stream) {
        yield [row.key, row.value];
        cnt++;
      }
    } catch (err: any) {
      this.logger.error(`error: ${this.tableName}, ${err}`);
    } finally {
      const end = Date.now();
      this.logger.debug(`done: ${this.tableName}, time: ${end - start}ms, count: ${cnt}`);
    }
  }

  async _next(callback: (err: Error | null, key?: T, value?: T) => void) {
    if (this.done) {
      callback(null, undefined, undefined);
      return;
    }
    const { value: kv, done } = await this.stream.next();
    if (done) {
      this.done = true;
      callback(null, undefined, undefined);
    } else {
      const [key, value] = kv;
      callback(null, key, value);
    }
  }

  _seek(target: K, options: AbstractSeekOptions<K>) {
    if (this.options.reverse) {
      if (this.options.lt && target < this.options.lt) {
        this.options.lt = target;
      } else if (this.options.lte && target <= this.options.lte) {
        this.options.lte = target;
      }
    } else {
      if (this.options.gt && target > this.options.gt) {
        this.options.gt = target;
      } else if (this.options.gte && target >= this.options.gte) {
        this.options.gte = target;
      }
    }
    this.stream = this.createStream();
    this.done = false;
  }
}
