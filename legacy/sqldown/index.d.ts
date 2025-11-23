declare module 'sqldown' {
  import { AbstractLevelDOWN, AbstractChainedBatch } from 'abstract-leveldown'
  
  class SQLDown extends AbstractLevelDOWN<any, any> {
    constructor(location: string)
    
    open(callback: (error?: Error) => void): void
    open(options: any, callback: (error?: Error) => void): void
    
    close(callback: (error?: Error) => void): void
    
    get(key: any, callback: (error: Error | null, value?: any) => void): void
    get(key: any, options: any, callback: (error: Error | null, value?: any) => void): void
    
    put(key: any, value: any, callback: (error?: Error) => void): void
    put(key: any, value: any, options: any, callback: (error?: Error) => void): void
    
    del(key: any, callback: (error?: Error) => void): void
    del(key: any, options: any, callback: (error?: Error) => void): void
    
    batch(): AbstractChainedBatch<any, any>
    batch(operations: Array<{ type: 'put' | 'del', key: any, value?: any }>, 
          callback: (error?: Error) => void): void
    batch(operations: Array<{ type: 'put' | 'del', key: any, value?: any }>, 
          options: any, callback: (error?: Error) => void): void
  }
  
  export = SQLDown
}