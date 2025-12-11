import { AbstractLevel } from 'abstract-level';
import { SQLUp } from './sqlup';
import { ClassicLevel } from 'classic-level';


interface BackendOptions {
  tableName?: string;
}

const backendCache = new Map<string, AbstractLevel<any, any, any>>();

export function getBackend(endpoint: string, options: BackendOptions): AbstractLevel<any, any, any> {
    const tableName = options.tableName || 'quadstore';
    const cacheKey = `${endpoint}::${tableName}`;
    
    if (backendCache.has(cacheKey)) {
      return backendCache.get(cacheKey)!;
    }

    const url = new URL(endpoint);
    const protocol = url.protocol;
    
    let backend: AbstractLevel<any, any, any>;

    if (protocol === 'file:') {
      backend = new ClassicLevel(endpoint.replace('file:', ''));
    } else if (protocol === 'sqlite:' || protocol === 'postgresql:' || protocol === 'mysql:') {
      backend = new SQLUp<Uint8Array>({
        url: endpoint,
        tableName: tableName,
      });
    } else {
      throw new Error(`Unsupported protocol: ${protocol}`);
    }

    backendCache.set(cacheKey, backend);
    return backend;
  }