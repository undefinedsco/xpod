import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AiClientConfigTransaction } from './transaction.js';
export function hashWebId(webId) {
    return crypto.createHash('sha256').update(webId.trim(), 'utf8').digest('hex');
}
export function normalizeV1Endpoint(endpoint) {
    const normalized = endpoint.trim().replace(/\/+$/, '');
    return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}
export function normalizeMessagesEndpoint(endpoint) {
    return endpoint.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}
export function parseJsonObject(content, label) {
    if (!content?.trim())
        return {};
    let value;
    try {
        value = JSON.parse(content);
    }
    catch (error) {
        throw new Error(`Cannot configure ${label}: invalid JSON (${String(error)})`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Cannot configure ${label}: root must be a JSON object`);
    }
    return value;
}
export function stringifyJson(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}
export function looksLikePreviousXpodValue(value) {
    return typeof value === 'string' && (value.includes('xpod') ||
        value.includes('/api/ai') ||
        value.includes('xpod.'));
}
export function stripLegacyXpodObject(value) {
    const legacy = value.xpod;
    if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
        delete value.xpod;
    }
}
export class BaseAiClientConfigAdapter {
    constructor(client, executable, configPaths, stateDirectory, transaction = new AiClientConfigTransaction()) {
        this.client = client;
        this.executable = executable;
        this.configPaths = configPaths;
        this.transaction = transaction;
        this.statePath = path.join(stateDirectory, `.xpod-ai-connection-${client}.json`);
    }
    async detect() {
        return {
            installed: await this.isExecutableOnPath(),
            configExists: (await Promise.all(this.configPaths.map((filePath) => this.exists(filePath)))).some(Boolean),
            configPaths: [...this.configPaths],
        };
    }
    async inspect() {
        const state = await this.readState();
        return {
            ownership: state ? 'owned' : 'unowned',
            ...(state ? { webIdHash: state.webIdHash } : {}),
            configPaths: [...this.configPaths],
        };
    }
    async plan(profile) {
        this.validateProfile(profile);
        const ownerHash = hashWebId(profile.webId);
        const currentState = await this.readState();
        if (currentState && currentState.webIdHash !== ownerHash) {
            throw new Error(`${this.client} AI Connection projection is owned by another WebID`);
        }
        const contents = new Map();
        for (const filePath of this.configPaths) {
            await this.rejectSymlink(filePath);
            contents.set(filePath, await this.readOptional(filePath));
        }
        const projected = await this.project(profile, contents);
        const timestamp = Date.now();
        const files = this.configPaths.map((filePath) => {
            const prior = currentState?.files.find((file) => file.path === filePath);
            const existed = contents.get(filePath) !== undefined;
            return prior ?? {
                path: filePath,
                existed,
                ...(existed ? { backupPath: `${filePath}.xpod-backup-${timestamp}` } : {}),
            };
        });
        const writes = [...projected.entries()].map(([filePath, content]) => ({
            path: filePath,
            content,
            backupPath: files.find((file) => file.path === filePath)?.backupPath,
            createBackup: !currentState && contents.get(filePath) !== undefined,
        }));
        const state = {
            version: 1,
            client: this.client,
            webIdHash: ownerHash,
            files,
        };
        writes.push({ path: this.statePath, content: stringifyJson(state) });
        return { client: this.client, webIdHash: ownerHash, writes };
    }
    async apply(plan) {
        if (plan.client !== this.client) {
            throw new Error(`Cannot apply ${plan.client} plan with ${this.client} adapter`);
        }
        await this.transaction.apply(plan.writes);
    }
    async verify(profile) {
        const state = await this.readState();
        if (!state || state.webIdHash !== hashWebId(profile.webId)) {
            return { ok: false, reason: 'AI Connection ownership does not match the current WebID' };
        }
        return this.verifyProjection(profile);
    }
    async restore(webId) {
        const state = await this.readState();
        if (!state)
            return;
        if (state.webIdHash !== hashWebId(webId)) {
            throw new Error(`${this.client} AI Connection projection is owned by another WebID`);
        }
        const writes = [];
        for (const file of state.files) {
            await this.rejectSymlink(file.path);
            const current = await this.readOptional(file.path);
            let original;
            if (file.existed) {
                if (!file.backupPath) {
                    throw new Error(`Missing ${this.client} backup metadata for ${file.path}`);
                }
                await this.rejectSymlink(file.backupPath);
                original = await this.readOptional(file.backupPath);
                if (original === undefined) {
                    throw new Error(`Missing ${this.client} backup at ${file.backupPath}`);
                }
            }
            writes.push({
                path: file.path,
                content: await this.restoreFile(file.path, current, original, file.existed),
            });
        }
        writes.push({ path: this.statePath, content: null });
        await this.transaction.apply(writes);
    }
    async readOptional(filePath) {
        try {
            return await fs.promises.readFile(filePath, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return undefined;
            throw error;
        }
    }
    validateProfile(profile) {
        if (!profile.endpoint.trim())
            throw new Error('AI Connection endpoint is required');
        if (!profile.gatewayKey.trim())
            throw new Error('AI Connection Gateway key is required');
        if (!profile.webId.trim())
            throw new Error('Current WebID is required');
    }
    async readState() {
        await this.rejectSymlink(this.statePath);
        const content = await this.readOptional(this.statePath);
        if (!content)
            return undefined;
        const parsed = parseJsonObject(content, `${this.client} ownership state`);
        if (parsed.version !== 1 || parsed.client !== this.client || typeof parsed.webIdHash !== 'string' ||
            !Array.isArray(parsed.files)) {
            throw new Error(`Invalid ${this.client} AI Connection ownership state`);
        }
        return parsed;
    }
    async rejectSymlink(filePath) {
        try {
            if ((await fs.promises.lstat(filePath)).isSymbolicLink()) {
                throw new Error(`Refusing to configure symbolic link: ${filePath}`);
            }
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
    async exists(filePath) {
        try {
            return (await fs.promises.lstat(filePath)).isFile();
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return false;
            throw error;
        }
    }
    async isExecutableOnPath() {
        const pathValue = process.env.PATH ?? '';
        for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
            try {
                await fs.promises.access(path.join(directory, this.executable), fs.constants.X_OK);
                return true;
            }
            catch {
                // Continue searching PATH.
            }
        }
        return false;
    }
}
