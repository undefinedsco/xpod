import type { ReactNode } from 'react';
import { SettingsAuthBoundary } from '../solid/SettingsAuthBoundary';

export function WebIdBoundary({ children }: { children: ReactNode }) {
  return <SettingsAuthBoundary>{children}</SettingsAuthBoundary>;
}
