import {
  AuthSurface,
  type AuthSurfaceProps,
} from '@undefineds.co/shared-ui';
import {
  AccountCredentialsSurface,
  type AccountCredentialsSurfaceProps,
} from './XpodAccountViews';
import { useXpodAuthWindowSurface } from './xpod-auth-surface-host';

export type XpodAuthSurfaceProps = Omit<
  AuthSurfaceProps,
  'host' | 'presentation' | 'className' | 'contentClassName'
>;

export type XpodBlockingAccountCredentialsSurfaceProps = Omit<
  AccountCredentialsSurfaceProps,
  'host' | 'presentation' | 'surfaceClassName' | 'contentClassName'
>;

/**
 * Product contract for every compact Xpod authentication state.
 *
 * The current browser viewport or Electron BrowserWindow is the container.
 * Feature code cannot add an overlay, nested card, or alternate presentation.
 */
export function XpodAuthSurface(props: XpodAuthSurfaceProps) {
  useXpodAuthWindowSurface();

  return (
    <AuthSurface
      {...props}
      presentation="compact"
      host="window"
    />
  );
}

/** Fixed product wrapper for blocking CSS Account credential states. */
export function XpodBlockingAccountCredentialsSurface(
  props: XpodBlockingAccountCredentialsSurfaceProps,
) {
  useXpodAuthWindowSurface();

  return (
    <AccountCredentialsSurface
      {...props}
      presentation="compact"
      host="window"
    />
  );
}
