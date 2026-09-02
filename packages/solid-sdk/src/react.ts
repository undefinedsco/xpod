import { createContext, createElement, useContext, type ReactNode } from 'react';
import type { OpenPodRuntime, PodRuntime } from './pod-runtime';
import type { SolidSessionRuntime, SolidSessionSnapshot } from './session';

export interface SolidRuntimeValue<Database = unknown> {
  readonly session: SolidSessionRuntime;
  readonly pod?: PodRuntime<Database>;
  readonly currentPod?: OpenPodRuntime<Database>;
}

export interface SolidRuntimeProviderProps<Database = unknown> {
  value: SolidRuntimeValue<Database>;
  children?: ReactNode;
}

const SolidRuntimeContext = createContext<SolidRuntimeValue | null>(null);

export function SolidRuntimeProvider<Database = unknown>({
  value,
  children,
}: SolidRuntimeProviderProps<Database>) {
  return createElement(
    SolidRuntimeContext.Provider,
    { value: value as SolidRuntimeValue },
    children,
  );
}

export function useSolidRuntime<Database = unknown>(): SolidRuntimeValue<Database> {
  const value = useContext(SolidRuntimeContext);
  if (!value) {
    throw new Error('useSolidRuntime must be used within SolidRuntimeProvider');
  }
  return value as SolidRuntimeValue<Database>;
}

export function useSolidSessionSnapshot(): SolidSessionSnapshot {
  return useSolidRuntime().session.getSnapshot();
}
