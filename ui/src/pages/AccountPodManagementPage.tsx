import { AccountPodManagement } from '../auth/AccountPodManagement';
import { XpodAccountPageSurface } from '../auth/XpodAuthSurface';

/** Account management remains available before the user has a WebID or Pod. */
export function AccountPodManagementPage() {
  return <XpodAccountPageSurface title="管理 Pod" presentation="standard"><AccountPodManagement /></XpodAccountPageSurface>;
}
