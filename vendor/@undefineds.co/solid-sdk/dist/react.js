import { createContext, createElement, useContext } from 'react';
const SolidRuntimeContext = createContext(null);
export function SolidRuntimeProvider({ value, children, }) {
    return createElement(SolidRuntimeContext.Provider, { value: value }, children);
}
export function useSolidRuntime() {
    const value = useContext(SolidRuntimeContext);
    if (!value) {
        throw new Error('useSolidRuntime must be used within SolidRuntimeProvider');
    }
    return value;
}
export function useSolidSessionSnapshot() {
    return useSolidRuntime().session.getSnapshot();
}
