import { createElement } from 'react';
import { defineAppletLayout as validateAppletLayout, } from './layout.js';
export { defineAppletLayout } from './layout.js';
const validateRawAppletLayout = validateAppletLayout;
export function defineApplet(applet) {
    return applet;
}
export function mountTwoPaneApplet(applet, host) {
    const mounted = mountResolvedApplet(applet, host);
    if (mounted.layout !== 'two-pane') {
        throw new Error(`Applet manifest declares ${applet.manifest.layout} but no two-pane slots were provided`);
    }
    return {
        controller: mounted.controller,
        header: mounted.slots.header,
        list: mounted.slots.list,
        main: mounted.slots.main,
    };
}
export function mountApplet(applet, host) {
    return mountResolvedApplet(applet, host);
}
function mountResolvedApplet(applet, host) {
    const layout = resolveAppletLayout(applet);
    const controller = applet.createController(host);
    if (layout.type === 'single-pane') {
        return {
            layout: 'single-pane',
            controller,
            element: createElement(layout.render, { controller, host }),
        };
    }
    if (layout.type === 'two-pane') {
        return {
            layout: 'two-pane',
            controller,
            slots: {
                header: createElement(layout.slots.header, { controller, host }),
                list: createElement(layout.slots.list, { controller, host }),
                main: createElement(layout.slots.main, { controller, host }),
            },
        };
    }
    return {
        layout: 'three-pane',
        controller,
        contextConfig: layout.contextConfig,
        slots: {
            header: createElement(layout.slots.header, { controller, host }),
            list: createElement(layout.slots.list, { controller, host }),
            main: createElement(layout.slots.main, { controller, host }),
            context: createElement(layout.slots.context, { controller, host }),
        },
    };
}
function resolveAppletLayout(applet) {
    if ('layout' in applet) {
        const descriptorLayout = requireDescriptorLayout(applet.layout);
        const descriptor = validateRawAppletLayout(descriptorLayout.descriptor);
        const descriptorType = descriptor.type;
        if (applet.manifest.layout !== descriptorType) {
            throw new Error(`Applet manifest layout ${applet.manifest.layout} does not match descriptor layout ${descriptorType}`);
        }
        if (descriptorType === 'single-pane') {
            if (!('render' in descriptorLayout)) {
                throw new Error('Applet descriptor single-pane render must be a function');
            }
            assertSlotFunction(descriptorLayout.render, 'Applet descriptor single-pane render');
            return {
                type: 'single-pane',
                render: descriptorLayout.render,
            };
        }
        if (!('slots' in descriptorLayout)) {
            throw new Error(`Applet descriptor declares ${descriptorType} but no slots were provided`);
        }
        if (descriptorType === 'two-pane') {
            assertTwoPaneSlots(descriptorLayout.slots, 'Applet descriptor two-pane');
            return {
                type: 'two-pane',
                slots: descriptorLayout.slots,
            };
        }
        assertThreePaneSlots(descriptorLayout.slots, 'Applet descriptor three-pane');
        return {
            type: 'three-pane',
            contextConfig: descriptor.context,
            slots: descriptorLayout.slots,
        };
    }
    if (applet.manifest.layout === 'single-pane') {
        if (!('render' in applet)) {
            throw new Error('Applet manifest declares single-pane but no single-pane renderer was provided');
        }
        assertSlotFunction(applet.render, 'Applet single-pane render');
        return {
            type: 'single-pane',
            render: applet.render,
        };
    }
    if (applet.manifest.layout === 'two-pane' && 'slots' in applet) {
        assertTwoPaneSlots(applet.slots, 'Applet two-pane');
        return {
            type: 'two-pane',
            slots: applet.slots,
        };
    }
    throw new Error(`Applet manifest declares ${applet.manifest.layout} but no supported applet layout was provided`);
}
function assertTwoPaneSlots(slots, label) {
    assertSlotContainer(slots, label);
    assertSlotFunction(slots.header, `${label} slot header`);
    assertSlotFunction(slots.list, `${label} slot list`);
    assertSlotFunction(slots.main, `${label} slot main`);
}
function assertThreePaneSlots(slots, label) {
    assertTwoPaneSlots(slots, label);
    assertSlotFunction(slots.context, `${label} slot context`);
}
function assertSlotContainer(value, label) {
    if (typeof value !== 'object' || value === null) {
        throw new Error(`${label} slots must be an object`);
    }
}
function assertSlotFunction(value, label) {
    if (typeof value !== 'function') {
        throw new Error(`${label} must be a function`);
    }
}
function requireDescriptorLayout(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Applet descriptor layout must be an object');
    }
    if (!('descriptor' in value) || value.descriptor === undefined) {
        throw new Error('Applet descriptor required');
    }
    return value;
}
