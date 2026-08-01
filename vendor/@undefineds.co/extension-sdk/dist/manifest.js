export const HOST_CAPABILITY_NAMES = [
    'navigation.openExternal',
    'aiClientConfiguration',
];
export function deriveAppletRouteId(manifest) {
    const segments = new URL(manifest.appId).pathname.split('/').filter(Boolean);
    const encodedRouteId = segments[segments.length - 1];
    const routeId = encodedRouteId ? decodeURIComponent(encodedRouteId) : undefined;
    if (!routeId || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(routeId)) {
        throw new Error(`Applet appId cannot produce a safe route id: ${manifest.appId}`);
    }
    return routeId;
}
export function validateExtensionManifest(value) {
    const manifest = requireRecord(value, 'Extension manifest');
    requireHttpsUrl(manifest.extensionId, 'extensionId');
    requireString(manifest.name, 'name');
    requireString(manifest.version, 'version');
    requireString(manifest.sdkVersion, 'sdkVersion');
    const contributes = requireRecord(manifest.contributes, 'contributes');
    if (!Array.isArray(contributes.applets) || contributes.applets.length === 0) {
        throw new Error('Extension manifest must contribute at least one Applet');
    }
    const appIds = new Set();
    for (const value of contributes.applets) {
        const applet = requireRecord(value, 'Applet manifest');
        const appId = requireHttpsUrl(applet.appId, 'appId');
        if (appIds.has(appId)) {
            throw new Error(`Extension manifest has duplicate appId: ${appId}`);
        }
        appIds.add(appId);
        requireString(applet.name, 'Applet name');
        requireString(applet.entry, 'Applet entry');
        if (!Array.isArray(applet.commands)) {
            throw new Error('Applet commands must be an array');
        }
        if (applet.layout !== 'single-pane' && applet.layout !== 'two-pane') {
            throw new Error('Applet layout must be single-pane or two-pane');
        }
    }
    if (!Array.isArray(manifest.dataModels)) {
        throw new Error('Extension dataModels must be an array');
    }
    if (!Array.isArray(manifest.hostCapabilities)) {
        throw new Error('Extension hostCapabilities must be an array');
    }
    for (const capability of manifest.hostCapabilities) {
        if (!HOST_CAPABILITY_NAMES.includes(capability)) {
            throw new Error(`Extension manifest requested unknown Host capability: ${String(capability)}`);
        }
    }
    return value;
}
function requireRecord(value, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${field} must be an object`);
    }
    return value;
}
function requireString(value, field) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${field} must be a non-empty string`);
    }
    return value;
}
function requireHttpsUrl(value, field) {
    const text = requireString(value, field);
    let url;
    try {
        url = new URL(text);
    }
    catch {
        throw new Error(`${field} must be a valid HTTPS URL`);
    }
    if (url.protocol !== 'https:') {
        throw new Error(`${field} must be a valid HTTPS URL`);
    }
    return text;
}
