import { getXpodAuthSurfaceHost } from '../auth/xpod-auth-surface-host';
import { DesktopEntryContent } from './WebDesktopEntry';
import { AccountPodManagement } from '../auth/AccountPodManagement';
import { XpodAccountPageSurface } from '../auth/XpodAuthSurface';

/** Legacy Account management follows the same native-host admission as product routes. */
export function AccountPodManagementPage() {
  if (getXpodAuthSurfaceHost() !== 'window') return <DesktopEntryContent />;
  return <XpodAccountPageSurface title="管理 Pod" presentation="standard"><AccountPodManagement /></XpodAccountPageSurface>;
}
