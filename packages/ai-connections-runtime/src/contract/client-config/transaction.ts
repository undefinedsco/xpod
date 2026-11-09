import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigWrite } from './types';

export interface AiClientConfigTransactionDependencies {
  rename?: (from: string, to: string) => Promise<void>;
}

interface Snapshot {
  path: string;
  existed: boolean;
  content?: Buffer;
  mode?: number;
}

export class AiClientConfigTransaction {
  private readonly rename: (from: string, to: string) => Promise<void>;

  public constructor(dependencies: AiClientConfigTransactionDependencies = {}) {
    this.rename = dependencies.rename ?? fs.promises.rename;
  }

  public async apply(writes: ConfigWrite[]): Promise<void> {
    const uniquePaths = new Set(writes.map((write) => path.resolve(write.path)));
    if (uniquePaths.size !== writes.length) {
      throw new Error('AI client configuration transaction contains duplicate paths');
    }

    for (const write of writes) {
      await this.preparePath(write.path);
      if (write.backupPath) {
        await this.preparePath(write.backupPath);
      }
    }

    const snapshots = await Promise.all(writes.map((write) => this.snapshot(write.path)));
    // Check all guarded writes before creating backups or changing any file.
    for (const write of writes) {
      this.assertExpectedContent(write, snapshots.find((snapshot) => snapshot.path === write.path)!.content);
    }
    const staged = new Map<string, string>();
    const applied: ConfigWrite[] = [];

    try {
      for (const write of writes) {
        const snapshot = snapshots.find((candidate) => candidate.path === write.path)!;
        if (write.createBackup && write.backupPath && snapshot.existed) {
          if (await this.exists(write.backupPath)) {
            throw new Error(`AI client configuration backup already exists: ${write.backupPath}`);
          }
          await this.writeNewFile(write.backupPath, snapshot.content!, snapshot.mode ?? 0o600);
        }
        if (write.content !== null) {
          staged.set(write.path, await this.stage(write.path, write.content));
        }
      }

      for (const write of writes) {
        if (write.expectedContentHash !== undefined) {
          this.assertExpectedContent(write, (await this.snapshot(write.path)).content);
        }
        if (write.content === null) {
          await fs.promises.rm(write.path, { force: true });
          applied.push(write);
        } else {
          await this.rename(staged.get(write.path)!, write.path);
          applied.push(write);
          await fs.promises.chmod(write.path, 0o600);
          await this.syncDirectory(path.dirname(write.path));
        }
      }
    } catch (error) {
      await this.rollback(snapshots, applied);
      throw error;
    } finally {
      await Promise.all([...staged.values()].map((tempPath) =>
        fs.promises.rm(tempPath, { force: true }).catch(() => undefined)));
    }
  }

  private async preparePath(filePath: string): Promise<void> {
    const directory = path.dirname(filePath);
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    await this.rejectSymlink(directory, true);
    await this.rejectSymlink(filePath);
  }

  private async rejectSymlink(filePath: string, allowDirectory = false): Promise<void> {
    try {
      const stats = await fs.promises.lstat(filePath);
      if (stats.isSymbolicLink()) {
        throw new Error(`Refusing to configure symbolic link: ${filePath}`);
      }
      if (!allowDirectory && stats.isDirectory()) {
        throw new Error(`Refusing to replace directory with AI client configuration: ${filePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  private async snapshot(filePath: string): Promise<Snapshot> {
    try {
      const stats = await fs.promises.lstat(filePath);
      if (!stats.isFile()) {
        throw new Error(`AI client configuration is not a regular file: ${filePath}`);
      }
      return {
        path: filePath,
        existed: true,
        content: await fs.promises.readFile(filePath),
        mode: stats.mode & 0o777,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { path: filePath, existed: false };
      }
      throw error;
    }
  }

  private async stage(targetPath: string, content: string): Promise<string> {
    const tempPath = path.join(
      path.dirname(targetPath),
      `.${path.basename(targetPath)}.xpod-tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`,
    );
    await this.writeNewFile(tempPath, Buffer.from(content, 'utf8'), 0o600);
    return tempPath;
  }

  private async writeNewFile(filePath: string, content: Buffer, mode: number): Promise<void> {
    const handle = await fs.promises.open(filePath, 'wx', mode);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.chmod(filePath, 0o600);
    await this.syncDirectory(path.dirname(filePath));
  }

  private assertExpectedContent(write: ConfigWrite, content: Buffer | undefined): void {
    if (write.expectedContentHash === undefined) return;
    const hash = content === undefined ? undefined : crypto.createHash('sha256').update(content).digest('hex');
    if (hash !== write.expectedContentHash) {
      throw new Error(`AI client configuration changed since planning: ${write.path}; retry with a fresh plan`);
    }
  }

  private async rollback(snapshots: Snapshot[], applied: ConfigWrite[]): Promise<void> {
    for (const write of [...applied].reverse()) {
      const snapshot = snapshots.find((candidate) => candidate.path === write.path)!;
      let tempPath: string | undefined;
      try {
        // An external client may refresh login state even after our write. Never
        // roll back a file unless it still contains exactly what we wrote.
        if (!await this.stillContainsWrite(write)) continue;
        if (!snapshot.existed) {
          await fs.promises.rm(snapshot.path, { force: true });
          continue;
        }
        tempPath = await this.stage(snapshot.path, snapshot.content!.toString('utf8'));
        if (!await this.stillContainsWrite(write)) continue;
        await this.rename(tempPath, snapshot.path);
        await fs.promises.chmod(snapshot.path, snapshot.mode ?? 0o600);
        await this.syncDirectory(path.dirname(snapshot.path));
      } catch {
        // Preserve the initiating failure. Backups remain available for recovery.
      } finally {
        if (tempPath) await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
      }
    }
  }

  private async stillContainsWrite(write: ConfigWrite): Promise<boolean> {
    const current = await this.snapshot(write.path);
    return write.content === null ? !current.existed :
      current.content?.equals(Buffer.from(write.content, 'utf8')) === true;
  }

  private async syncDirectory(directory: string): Promise<void> {
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(directory, 'r');
      await handle.sync();
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw error;
      }
    } finally {
      await handle?.close();
    }
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
