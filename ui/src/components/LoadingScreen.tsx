import { Loader2 } from 'lucide-react';
import { AuthSurface } from '@undefineds.co/shared-ui';
import { XpodLoginBrand } from '../auth/XpodLoginBrand';
import { getXpodAuthSurfaceHost } from '../auth/xpod-auth-surface-host';

export function LoadingScreen() {
  return (
    <AuthSurface
      mode="page"
      title="正在加载 Xpod"
      presentation="compact"
      host={getXpodAuthSurfaceHost()}
      lead={<XpodLoginBrand compact showSubtitle />}
    >
      <div role="status" aria-live="polite" className="flex flex-1 items-center justify-center p-5 text-sm text-muted-foreground">
        <Loader2 aria-hidden="true" className="mr-2 h-5 w-5 animate-spin" />
        正在加载…
      </div>
    </AuthSurface>
  );
}
