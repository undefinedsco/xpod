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

export class SQLUp<T extends TFormat, K = string, V = string> extends AbstractLevel<T, K, V> {
  private readonly logger = getLoggerFor(this);
  private db: Knex;
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

  async setupQueryLog() {
    this.db.on('query', (query) => {
      query.__queryID = Math.random().toString(36).substr(2, 9);
      this.logger.debug(`Query[${query.__queryID}] executing: ${query.sql} ${JSON.stringify(query.bindings)}`);
    });
    this.db.on('query-error', (query, error) => {
      this.logger.error(`Query[${query.__queryID}] error: ${error}`);
    });
    this.db.on('query-response', (query, response) => {
      this.logger.debug(`Query[${query.__queryID}] response done`);
    });
  }

  async _open(options: AbstractOpenOptions, callback: NodeCallback<void>) {
    const parsedUrl = new URL(this.url);
    this.logger.info(`Opening database at ${this.url}`);
    try {
        if (parsedUrl.protocol === 'sqlite:') {
        this.logger.info(`Opening SQLite database at ${parsedUrl.pathname}`);
        const filename = parsedUrl.toString().replace('sqlite:', '');
        const directory = path.dirname(filename);
        if (!fs.existsSync(directory)) {
          fs.mkdirSync(directory, { recursive: true });
        }
        this.db = knex({
          client: 'sqlite3',
          connection: {
            filename: filename
          },
          useNullAsDefault: true
        });
      } else if (parsedUrl.protocol === 'postgresql:') {
        this.db = knex({
          client: 'pg',
          connection: parsedUrl.toString(),
          pool: { min: 2, max: 5 }
        });
      } else if (parsedUrl.protocol === 'mysql:') {
        this.db = knex({
          client: 'mysql2',
          connection: parsedUrl.toString(),
          pool: { min: 2, max: 5 }
        });
      } else {
        return callback(new Error('Unsupported database protocol'));
      }
      // this.setupQueryLog();
      const exists = await this.db.schema.hasTable(this.tableName);
      if (!exists) {
        await this.db.schema.createTable(this.tableName, (table) => {
          table.increments('id').primary();
          if (this.format === 'utf8') {
            table.text('key').index();
            table.text('value');
          } else {
            table.binary('key').index();
            table.binary('value');
          }
        });
      }
      this.logger.info(`Database ${this.tableName} opened`);
      callback(null);
    } catch (err: any) {
      return callback(err);
    }
  }

  async _close(callback: NodeCallback<void>) {
    try {
      await this.db.destroy();
      callback(null);
    } catch (err: any) {
      callback(err);
    }
  }

  async _get(key: T, options: AbstractGetOptions<K, V>, callback: NodeCallback<T>) {
    try {
      const [row] = await this.db.select('value')
        .from(this.tableName)
        .where('key', key);
      callback(null, row?.value);
    } catch (err: any) {
      callback(err);
    }
  }

  async _getMany(keys: T[], options: AbstractGetManyOptions<K, V>, callback: NodeCallback<T[]>) {
    try {
      const rows = await this.db.select('value')
        .from(this.tableName)
        .whereIn('key', keys);
      callback(null, rows.map((row) => row.value));
    } catch (err: any) {
      callback(err);
    }
  }

  async _put(key: T, value: T, options: AbstractPutOptions<K, V>, callback: NodeCallback<void>) {
    try {
      await this.db
        .insert({'key': key, 'value': value})
        .into(this.tableName);
      callback(null);
    } catch (err: any) {
      callback(err);
    }
  }

  async _del(key: T, options: AbstractDelOptions<K>, callback: NodeCallback<void>) {
    try {
      await this.db.delete()
        .from(this.tableName)
        .where('key', key);
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
    try {
      await this.db.transaction(async (trx) => {
        const putOperations: Record<string, T>[] = [];
        const delOperations: T[] = [];
        operations.forEach((operation) => {
          if (operation.type === 'put') {
            putOperations.push({'key': operation.key, 'value': operation.value});
          } else if (operation.type === 'del') {
            delOperations.push(operation.key);
          }
        });
        if (putOperations.length > 0) {
          await trx.insert(putOperations).into(this.tableName);
        }
        if (delOperations.length > 0) {
          await trx.delete().from(this.tableName).whereIn('key', delOperations);
        }
      });
      callback(null);
    } catch (err: any) {
      callback(err);
    }
  }

  _sublevel(name: string) {
    return new SQLUp({
      url: this.url,
      tableName: `${this.tableName}_${name}`
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
    // const keyEncoding = this.options.keyEncoding as Transcoder.PartialEncoding<K>;
    // const valueEncoding = this.options.valueEncoding as Transcoder.PartialEncoding<V>;
    const keyEncoding = this.db.keyEncoding();
    let query = this.knex.select('key', 'value').from(this.tableName);
    if (this.options.gt) {
      query = query.where('key', '>', keyEncoding.encode(this.options.gt));
    } else if (this.options.gte) {
      query = query.where('key', '>=', keyEncoding.encode(this.options.gte));
    }
    if (!this.options.lt && this.options.lte) {
      // const key = keyEncoding.encode(this.options.lte);
      // this.options.lt = keyEncoding.decode(this.getKeyAddOne(key));
      // this.options.lte = undefined;
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
    let cnt: number = 0
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

  getKeyAddOne(key: T): T {
    const length = key.length;
    this.logger.debug(`Key length: ${length} type: ${typeof key}`);
    if (length < 4) {
      throw new Error('Key length must be at least 4');
    }
    if (key instanceof Buffer) {
      key.forEach((element, index) => {
        this.logger.debug(`Key byte ${index}: ${element}`);
      });
    }
    const buffer = key instanceof Buffer ? key : Buffer.from(key);

    // 从最后两个字节读取为一个 32 位整数
    const lastTwoBytes = buffer.readUInt32BE(length - 4);
    // 增加 1
    const nextTwoBytes = lastTwoBytes + 1;
    // 将结果写入一个新的 Buffer
    const nextBuffer = Buffer.from(buffer);
    // 将新的 Buffer 转换为 Uint8Array
    // nextBuffer.writeUInt32BE(nextTwoBytes, length - 4);

    const byteSequence = Buffer.from([0x00, 0x01, 0x00, 0x00]);
    byteSequence.copy(nextBuffer, length - 4);

    if (this.db.format === 'buffer') {
      return nextBuffer as T;
    } else if (this.db.format === 'view') {
      return new Uint8Array(nextBuffer) as T;
    } else {
      throw new Error('Unsupported key type');
    }
  }

  async _next(callback: (err: Error | null, key?: T, value?: T) => void) {
    if (this.done) {
      callback(null, undefined, undefined);
      return;
    }
    const { value: kv, done} = await this.stream.next();
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
