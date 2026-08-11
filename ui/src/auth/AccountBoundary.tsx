import type { ReactNode } from 'react';
import { AccountAuthBoundary } from './AccountAuthBoundary';

/** @deprecated Use AccountAuthBoundary directly. */
export function AccountBoundary({
  children,
}: {
  children: ReactNode;
  /** Retained only so older callers compile; product auth never raw-navigates. */
  redirectToLogin?: (url: string) => void;
}) {
  return <AccountAuthBoundary>{children}</AccountAuthBoundary>;
}
