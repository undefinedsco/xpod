export function defineAppletLayout(descriptor) {
    if (!isPlainDescriptorObject(descriptor)) {
        throw new Error('Applet layout descriptor must be an object');
    }
    if (typeof descriptor.type !== 'string') {
        throw new Error('Applet layout descriptor type must be a string');
    }
    switch (descriptor.type) {
        case 'single-pane':
        case 'two-pane':
            assertValidLayoutContext(descriptor.context);
            return descriptor;
        case 'three-pane':
            assertValidLayoutContext(descriptor.context);
            return descriptor;
        default:
            throw new Error(`Unsupported applet layout type: ${descriptor.type}`);
    }
}
function isPlainDescriptorObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function assertValidLayoutContext(context) {
    if (context === undefined) {
        return;
    }
    if (!isPlainDescriptorObject(context)) {
        throw new Error('Applet layout descriptor context must be an object');
    }
    if ('collapsible' in context && typeof context.collapsible !== 'boolean') {
        throw new Error('Applet layout descriptor context.collapsible must be a boolean');
    }
    if ('initiallyCollapsed' in context && typeof context.initiallyCollapsed !== 'boolean') {
        throw new Error('Applet layout descriptor context.initiallyCollapsed must be a boolean');
    }
}
