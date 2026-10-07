import { createContext, useContext } from 'react';
import type { ShellAttentionSnapshot } from '@undefineds.co/extension-sdk';

export interface ShellResumeFailure { approvalId: string; run: string; message: string; busy?: boolean }
export interface ShellState {
  snapshot: ShellAttentionSnapshot;
  loading: boolean;
  resumeFailures: ShellResumeFailure[];
  retryResume(approvalId: string, run: string): Promise<void>;
  error?: string;
  refresh(): void;
  markAllRead(): void;
  decide(iri: string, decision: 'approved' | 'rejected'): Promise<void>;
}
export const ShellContext = createContext<ShellState | null>(null);
export function useOptionalShellState(): ShellState | null {
  return useContext(ShellContext);
}
export function useShellState(): ShellState {
  const value = useOptionalShellState();
  if (!value) throw new Error('ShellStateProvider is required');
  return value;
}
