import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PendingOperation } from './pod-lower';

/**
 * Durable client-side delta for the mount prototype. It is explicitly NOT a
 * content authority: the Pod stays authoritative; this file only remembers
 * dirty/pending operations that must be written back before a session closes.
 * Body bytes are stored only for unsaved local edits, never as a read cache.
 */
export class PodLowerPendingStore {
  private readonly filePath: string;

  public constructor(sessionDir: string) {
    this.filePath = path.join(sessionDir, 'pending-ops.json');
  }

  public get path(): string {
    return this.filePath;
  }

  public load(): PendingOperation[] {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as PendingOperation[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  public save(operations: PendingOperation[]): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(operations, null, 2)}\n`, 'utf8');
  }
}
