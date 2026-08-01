import { type ReactNode } from 'react';
import type { OpenPodRuntime, PodRuntime } from './pod-runtime';
import type { SolidSessionRuntime, SolidSessionSnapshot } from './session';
export interface SolidRuntimeValue<Database = unknown> {
    readonly session: SolidSessionRuntime;
    readonly pod: PodRuntime<Database>;
    readonly currentPod?: OpenPodRuntime<Database>;
}
export interface SolidRuntimeProviderProps<Database = unknown> {
    value: SolidRuntimeValue<Database>;
    children?: ReactNode;
}
export declare function SolidRuntimeProvider<Database = unknown>({ value, children, }: SolidRuntimeProviderProps<Database>): import("react").FunctionComponentElement<import("react").ProviderProps<SolidRuntimeValue<unknown> | null>>;
export declare function useSolidRuntime<Database = unknown>(): SolidRuntimeValue<Database>;
export declare function useSolidSessionSnapshot(): SolidSessionSnapshot;
