import { useEffect, useMemo } from 'react';
import { mountApplet, } from './web.js';
export * from './react/layout-context.js';
export * from './react/app-layout.js';
export * from './react/workspace-layout.js';
export * from './react/auth-boundary.js';
export function useApplet(applet, host, options = {}) {
    const enabled = options.enabled ?? true;
    const mounted = useMemo(() => enabled
        ? mountApplet(applet, host)
        : null, [applet, enabled, host]);
    useEffect(() => {
        if (!mounted) {
            return undefined;
        }
        return applet.activate?.(mounted.controller, host);
    }, [applet, host, mounted]);
    return mounted;
}
