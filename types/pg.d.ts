declare module 'pg' {
  export class Pool {
    constructor(config?: any);
    query<T = any>(text: string, params?: any[]): Promise<{ rows: T[] }>;
    end(): Promise<void>;
    connect(): Promise<any>;
  }
}
