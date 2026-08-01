import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
export class AiClientConfigTransaction {
    constructor(dependencies = {}) {
        this.rename = dependencies.rename ?? fs.promises.rename;
    }
    async apply(writes) {
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
        const staged = new Map();
        try {
            for (const write of writes) {
                const snapshot = snapshots.find((candidate) => candidate.path === write.path);
                if (write.createBackup && write.backupPath && snapshot.existed) {
                    if (await this.exists(write.backupPath)) {
                        throw new Error(`AI client configuration backup already exists: ${write.backupPath}`);
                    }
                    await this.writeNewFile(write.backupPath, snapshot.content, snapshot.mode ?? 0o600);
                }
                if (write.content !== null) {
                    staged.set(write.path, await this.stage(write.path, write.content));
                }
            }
            for (const write of writes) {
                if (write.content === null) {
                    await fs.promises.rm(write.path, { force: true });
                }
                else {
                    await this.rename(staged.get(write.path), write.path);
                    await fs.promises.chmod(write.path, 0o600);
                    await this.syncDirectory(path.dirname(write.path));
                }
            }
        }
        catch (error) {
            await this.rollback(snapshots);
            throw error;
        }
        finally {
            await Promise.all([...staged.values()].map((tempPath) => fs.promises.rm(tempPath, { force: true }).catch(() => undefined)));
        }
    }
    async preparePath(filePath) {
        const directory = path.dirname(filePath);
        await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
        await this.rejectSymlink(directory, true);
        await this.rejectSymlink(filePath);
    }
    async rejectSymlink(filePath, allowDirectory = false) {
        try {
            const stats = await fs.promises.lstat(filePath);
            if (stats.isSymbolicLink()) {
                throw new Error(`Refusing to configure symbolic link: ${filePath}`);
            }
            if (!allowDirectory && stats.isDirectory()) {
                throw new Error(`Refusing to replace directory with AI client configuration: ${filePath}`);
            }
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
    }
    async snapshot(filePath) {
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
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return { path: filePath, existed: false };
            }
            throw error;
        }
    }
    async stage(targetPath, content) {
        const tempPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.xpod-tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
        await this.writeNewFile(tempPath, Buffer.from(content, 'utf8'), 0o600);
        return tempPath;
    }
    async writeNewFile(filePath, content, mode) {
        const handle = await fs.promises.open(filePath, 'wx', mode);
        try {
            await handle.writeFile(content);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await fs.promises.chmod(filePath, 0o600);
        await this.syncDirectory(path.dirname(filePath));
    }
    async rollback(snapshots) {
        for (const snapshot of [...snapshots].reverse()) {
            try {
                if (!snapshot.existed) {
                    await fs.promises.rm(snapshot.path, { force: true });
                    continue;
                }
                const tempPath = await this.stage(snapshot.path, snapshot.content.toString('utf8'));
                await this.rename(tempPath, snapshot.path);
                await fs.promises.chmod(snapshot.path, snapshot.mode ?? 0o600);
                await this.syncDirectory(path.dirname(snapshot.path));
            }
            catch {
                // Preserve the initiating failure. Backups remain available for recovery.
            }
        }
    }
    async syncDirectory(directory) {
        let handle;
        try {
            handle = await fs.promises.open(directory, 'r');
            await handle.sync();
        }
        catch (error) {
            if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code ?? '')) {
                throw error;
            }
        }
        finally {
            await handle?.close();
        }
    }
    async exists(filePath) {
        try {
            await fs.promises.access(filePath);
            return true;
        }
        catch {
            return false;
        }
    }
}
