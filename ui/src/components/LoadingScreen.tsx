import { Loader2 } from 'lucide-react';
import { XpodAccountPageSurface } from '../auth/XpodAuthSurface';

export function LoadingScreen() {
  return (
    <XpodAccountPageSurface
      title="正在加载 Xpod"
    >
      <div role="status" aria-live="polite" className="flex flex-1 items-center justify-center p-5 text-sm text-muted-foreground">
        <Loader2 aria-hidden="true" className="mr-2 h-5 w-5 animate-spin" />
        正在加载…
      </div>
    </XpodAccountPageSurface>
  );
}
