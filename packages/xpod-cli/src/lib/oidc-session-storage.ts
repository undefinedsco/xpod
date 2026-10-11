import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { IStorage } from '@inrupt/solid-client-authn-node';
import { getSolidAuthDir } from './credentials-store';

function storageDir(): string {
  return join(getSolidAuthDir(), 'oidc-storage');
}

function keyPath(key: string): string {
  return join(storageDir(), encodeURIComponent(key));
}

export function createOidcSessionStorage(): IStorage {
  return {
    async get(key: string): Promise<string | undefined> {
      const path = keyPath(key);
      if (!existsSync(path)) return undefined;
      return readFileSync(path, 'utf-8');
    },
    async set(key: string, value: string): Promise<void> {
      mkdirSync(storageDir(), { recursive: true });
      const path = keyPath(key);
      writeFileSync(path, value, 'utf-8');
      chmodSync(path, 0o600);
    },
    async delete(key: string): Promise<void> {
      const path = keyPath(key);
      if (existsSync(path)) unlinkSync(path);
    },
  };
}

export function clearOidcSessionStorage(): void {
  const dir = storageDir();
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
