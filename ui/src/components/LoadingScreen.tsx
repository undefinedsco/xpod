import { Loader2 } from 'lucide-react';
import { AuthSurface } from '@undefineds.co/shared-ui';

export function LoadingScreen() {
  return (
    <AuthSurface mode="page" title="Loading">
      <div role="status" aria-live="polite" className="flex items-center justify-center p-8 text-sm text-muted-foreground">
        <Loader2 aria-hidden="true" className="mr-2 h-5 w-5 animate-spin" />
        Loading…
      </div>
    </AuthSurface>
  );
}
