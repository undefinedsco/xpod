export const AI_CONNECTION_APPLET_ID = 'co.undefineds.ai-connection';
const KNOWN_RESOURCE_IDS = new Set([
    'providerCredentials',
    'providerDefinitions',
    'gatewayAccessKeys',
    'quotaSnapshots',
]);
export function parseAiConnectionServiceAccess(value, currentPodUrl) {
    if (!isRecord(value))
        throw new Error('invalid_descriptor');
    if (value.appletId !== AI_CONNECTION_APPLET_ID)
        throw new Error('invalid_applet_id');
    const service = value.service;
    if (!isRecord(service)
        || typeof service.webId !== 'string'
        || typeof service.label !== 'string'
        || !isAbsoluteHttpUrl(service.webId)) {
        throw new Error('invalid_service');
    }
    if (!Array.isArray(value.resources) || value.resources.length === 0) {
        throw new Error('invalid_empty_resources');
    }
    const podRoot = normalizeContainerUrl(currentPodUrl);
    const ids = new Set();
    const resources = value.resources.map((resource) => parseResource(resource, podRoot, ids));
    return {
        appletId: AI_CONNECTION_APPLET_ID,
        service: {
            webId: service.webId,
            label: service.label,
        },
        resources,
    };
}
function parseResource(value, podRoot, ids) {
    if (!isRecord(value)
        || typeof value.id !== 'string'
        || typeof value.url !== 'string'
        || value.mediaType !== 'text/turtle'
        || !isRecord(value.access)) {
        throw new Error('invalid_resource');
    }
    if (!KNOWN_RESOURCE_IDS.has(value.id) || ids.has(value.id)) {
        throw new Error('invalid_resource');
    }
    assertSafeResourceUrlString(value.url);
    let url;
    try {
        url = new URL(value.url);
    }
    catch {
        throw new Error('invalid_resource');
    }
    if (!isInsideContainer(url, podRoot)) {
        throw new Error('invalid_resource');
    }
    ids.add(value.id);
    return {
        id: value.id,
        url: url.href,
        mediaType: 'text/turtle',
        access: parseAccess(value.access),
    };
}
function assertSafeResourceUrlString(value) {
    if (/%(?![0-9a-fA-F]{2})/.test(value)
        || /%(?:2f|5c)/i.test(value)
        || value.includes('\\')) {
        throw new Error('invalid_resource');
    }
    const rawPath = extractRawPath(value);
    if (hasDotSegment(rawPath)) {
        throw new Error('invalid_resource');
    }
    try {
        const decodedPath = decodeURIComponent(rawPath);
        if (decodedPath.includes('\\') || hasDotSegment(decodedPath)) {
            throw new Error('invalid_resource');
        }
    }
    catch {
        throw new Error('invalid_resource');
    }
}
function extractRawPath(value) {
    const withoutHash = value.split('#', 1)[0] ?? value;
    const withoutQuery = withoutHash.split('?', 1)[0] ?? withoutHash;
    return withoutQuery.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/\\?#]*/i, '');
}
function hasDotSegment(path) {
    return path.split('/').some((segment) => segment === '.' || segment === '..');
}
function parseAccess(value) {
    const keys = Object.keys(value);
    if (keys.some((key) => key !== 'read' && key !== 'append' && key !== 'write')
        || value.read !== true
        || value.append !== true
        || value.write !== true) {
        throw new Error('invalid_resource');
    }
    return {
        read: true,
        append: true,
        write: true,
    };
}
function normalizeContainerUrl(value) {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('invalid_current_pod');
    }
    if (!url.pathname.endsWith('/')) {
        url.pathname = `${url.pathname}/`;
    }
    return url;
}
function isInsideContainer(url, root) {
    return (url.protocol === 'http:' || url.protocol === 'https:')
        && url.origin === root.origin
        && url.pathname.startsWith(root.pathname);
}
function isAbsoluteHttpUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    }
    catch {
        return false;
    }
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
