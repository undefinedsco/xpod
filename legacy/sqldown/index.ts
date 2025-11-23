import { Knex, knex } from 'knex';
import { 
  AbstractLevelDOWN,
  AbstractChainedBatch,
  AbstractIterator,
  AbstractIteratorOptions
} from 'abstract-leveldown';

import {
  AbstractLevel,
  AbstractKeyIterator,
  AbstractValueIterator
} from 'abstract-level';

export class SQLDOWN implements AbstractLevelDOWN<string, string, any> {
  private db: Knex;
  private tableName: string;

  constructor(url: string, tableName: string = 'sqldown') {
    this.tableName = tableName;
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol === 'sqlite:') {
      this.db = knex({
        client: 'sqlite3',
        connection: {
          filename: parsedUrl.pathname
        }
      });
    } else if (parsedUrl.protocol === 'postgresql:') {
      this.db = knex({
        client: 'pg',
        connection: parsedUrl.toString().replace('postgresql:', '')
      });
    } else if (parsedUrl.protocol === 'mysql:') {
      this.db = knex({
        client: 'mysql2',
        connection: parsedUrl.toString().replace('mysql:', '')
      });
    }
  }

  public async open(callback: ErrorCallback): Promise<void> {
    try {
      const exists = await this.db.schema.hasTable(this.tableName);
      if (!exists) {
        await this.db.schema.createTable(this.tableName, table => {
          table.string('key').primary();
          table.string('value');
        });
      }
    } catch (error: any) {
      callback(error);
    }
  }

  public async close(callback: ErrorCallback): Promise<void> {
    // 关闭连接
    try {
      await this.db.destroy();
    } catch (error: any) {
      callback(error);
    }
  }

  public async get(key: string, callback: (err: Error | null, value: string) => void): Promise<void> {
    try {
      const row = await this.db(this.tableName).where('key', key).first('value');
      if (row) {
        callback(null, row.value);
      } else {
        callback(new Error('NotFound'), '');
      }
    } catch (error: any) {
      callback(error, '');
    }
  }

  public async put(key: string, value: string, callback: ErrorCallback): Promise<void> {
    try {
      await this.db(this.tableName).insert({ key, value }).onConflict('key').merge();
    } catch (error: any) {
      callback(error);
    }
  }

  public async del(key: string, callback: ErrorCallback): Promise<void> {
    try {
      await this.db(this.tableName).where('key', key).del();
    } catch (error: any) {
      callback(error);
    }
  }

  public batch(): AbstractChainedBatch<string, string>;
  public batch(
    operations: Array<{ type: 'put' | 'del', key: string, value?: string }>, 
    callback: ErrorCallback
  ): void;
  public batch(
    operations?: Array<{ type: 'put' | 'del', key: string, value?: string }>, 
    callback?: ErrorCallback
  ): void | AbstractChainedBatch<string, string> {
    if (!operations) {
      return new SQLDOWNBatch(this.db, this.tableName);
    }
    try {
      this.db.transaction(async trx => {
        const operationPromises: Promise<any>[] = (operations || []).map(op => {
          if (op.type === 'put') {
            // 使用事务实例插入或更新
          return trx(this.tableName).insert({ key: op.key, value: op.value })
            .onConflict('key').merge();
          } else if (op.type === 'del') {
            // 使用事务实例删除
            return trx(this.tableName).where('key', op.key).del();
          } else {
            // 如果操作类型不支持，抛出错误
            return Promise.reject(new Error(`Unsupported operation type: ${op.type}`));
          }
        });
        await Promise.all(operationPromises).then(() => trx.commit()).catch(trx.rollback);
      });
    } catch (error: any) {
      if (callback) callback(error);
    }
  }

  public iterator(
    options: AbstractIteratorOptions<string>
  ): AbstractIterator<string, string> {
    return new SQLDOWNIterator(this.db, this.tableName, options);
  }

  public keys(options: AbstractIteratorOptions<string>): AbstractKeyIterator<typeof this, string> {
    return this.iterator(options);
  }

  public values(): AbstractValueIterator<typeof this, string, string> {
    return this.iterator({ values: true });
  }

  public async approximateSize(
    start: string, 
    end: string, 
    callback: (err: Error | null, size: number) => void
  ): Promise<void> {
    try {
      const count = await this.db(this.tableName).where('key', '>=', start).where('key', '<=', end).count('key as count');
      callback(null, Number(count[0].count));
    } catch (error: any) {
      callback(error, 0);
    }
  }
}

class SQLDOWNBatch extends AbstractChainedBatch<string, string> {
  private db: Knex;
  private tableName: string;
  private operations: Array<{ type: 'put' | 'del', key: string, value?: string }> = [];

  constructor({ db, tableName }: { db: Knex, tableName: string }) {
    super(db);
    this.db = db;
    this.tableName = tableName;
    this.operations = [];
  }

  public put(key: string, value: string): this {
    this.operations.push({ type: 'put', key, value });
    return this;
  }

  public del(key: string): this {
    this.operations.push({ type: 'del', key });
    return this;
  }

  public clear(): this {
    this.operations = [];
    return this;
  }

  public write(callback: ErrorCallback): void {
    // 使用事务实例执行批量操作
    try {
      this.db.transaction(async trx => {
        const operationPromises: Promise<any>[] = this.operations.map(op => {
          return trx(this.tableName).insert({ key: op.key, value: op.value })
        });
        await Promise.all(operationPromises).then(() => trx.commit()).catch(trx.rollback);
      });
    } catch (error: any) {
      callback(error);
    }
  }
}

class SQLDOWNIterator extends AbstractIterator<string, string> {
  private db: Knex;
  private tableName: string;
  private options: AbstractIteratorOptions;
  private resultSet: { key: string, value: string }[] = [];
  private index: number = 0;

  constructor(db: Knex, tableName: string, options: AbstractIteratorOptions<string>) {
    super(db);
    this.db = db;
    this.tableName = tableName;
    this.options = options;
    this.index = 0;
  }

  private async loadResults(): Promise<void> {
    let query = this.db(this.tableName).select('key', 'value');

    // Add range options filtering if needed
    if (this.options.gt) {
      query = query.where('key', '>', this.options.gt);
    }

    if (this.options.gte) {
      query = query.where('key', '>=', this.options.gte);
    }

    if (this.options.lt) {
      query = query.where('key', '<', this.options.lt);
    }

    if (this.options.lte) {
      query = query.where('key', '<=', this.options.lte);
    }

    // Order the results
    query = query.orderBy('key', this.options.reverse ? 'desc' : 'asc');

    // Limit results, if provided
    if (typeof this.options.limit === 'number') {
      query = query.limit(this.options.limit);
    }

    this.resultSet = await query;
  }

  public _next(callback: (err: Error | null, key?: string, value?: string) => void): void {
    if (this.index === 0) {
      this.loadResults().then(() => this._next(callback)).catch(err => callback(err));
      return;
    }

    if (this.index < this.resultSet.length) {
      const { key, value } = this.resultSet[this.index++];
      callback(null, key, value);
    } else {
      callback(null); // Signal end of iteration
    }
  }
}