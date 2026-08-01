import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BaseAiClientConfigAdapter, looksLikePreviousXpodValue, normalizeV1Endpoint, parseJsonObject, stringifyJson, stripLegacyXpodObject, } from './base-adapter.js';
export class PiConfigAdapter extends BaseAiClientConfigAdapter {
    constructor(options = {}) {
        const dir = path.join(options.homeDir ?? os.homedir(), '.pi', 'agent');
        const settingsPath = path.join(dir, 'settings.json');
        const modelsPath = path.join(dir, 'models.json');
        super('pi', 'pi', [settingsPath, modelsPath], dir);
        this.settingsPath = settingsPath;
        this.modelsPath = modelsPath;
    }
    async project(profile, current) {
        const settings = parseJsonObject(current.get(this.settingsPath), 'Pi settings.json');
        const models = parseJsonObject(current.get(this.modelsPath), 'Pi models.json');
        const providers = models.providers && typeof models.providers === 'object' && !Array.isArray(models.providers)
            ? { ...models.providers }
            : {};
        const model = profile.model?.trim() || 'default';
        settings.defaultProvider = 'xpod';
        settings.defaultModel = model;
        providers.xpod = {
            baseUrl: normalizeV1Endpoint(profile.endpoint),
            apiKey: profile.gatewayKey,
            authHeader: true,
            api: 'openai-responses',
            models: [{ id: model, name: model }],
        };
        models.providers = providers;
        return new Map([
            [this.settingsPath, stringifyJson(settings)],
            [this.modelsPath, stringifyJson(models)],
        ]);
    }
    async verifyProjection(profile) {
        try {
            const models = parseJsonObject(await fs.promises.readFile(this.modelsPath, 'utf8'), 'Pi models.json');
            const xpod = models.providers?.xpod;
            const ok = xpod?.baseUrl === normalizeV1Endpoint(profile.endpoint) &&
                xpod.apiKey === profile.gatewayKey;
            return ok ? { ok: true } : { ok: false, reason: 'Pi projection differs from the requested connection' };
        }
        catch (error) {
            return { ok: false, reason: String(error) };
        }
    }
    async restoreFile(filePath, current, original, originallyExisted) {
        const restored = parseJsonObject(current, `Pi ${path.basename(filePath)}`);
        const before = parseJsonObject(original, `Pi original ${path.basename(filePath)}`);
        stripLegacyXpodObject(restored);
        if (filePath === this.settingsPath) {
            restoreOwnedProperty(restored, before, 'defaultProvider');
            restoreOwnedProperty(restored, before, 'defaultModel');
        }
        else {
            const restoredProviders = isObject(restored.providers) ? { ...restored.providers } : {};
            const beforeProviders = isObject(before.providers) ? before.providers : {};
            restoreOwnedProperty(restoredProviders, beforeProviders, 'xpod');
            if (Object.keys(restoredProviders).length > 0 || Object.prototype.hasOwnProperty.call(before, 'providers')) {
                restored.providers = restoredProviders;
            }
            else {
                delete restored.providers;
            }
        }
        return !originallyExisted && Object.keys(restored).length === 0 ? null : stringifyJson(restored);
    }
}
function restoreOwnedProperty(target, original, key) {
    if (key === 'xpod' || looksLikePreviousXpodValue(original[key])) {
        delete target[key];
    }
    else if (Object.prototype.hasOwnProperty.call(original, key)) {
        target[key] = original[key];
    }
    else {
        delete target[key];
    }
}
function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
