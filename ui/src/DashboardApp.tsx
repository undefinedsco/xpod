import type { XpodSolidRuntimeCore } from './solid/XpodSolidRuntime';
import { XpodShellApp } from './XpodShellApp';

export interface DashboardAppProps {
  runtime?: XpodSolidRuntimeCore;
  initialPathname?: string;
}

export function DashboardApp({ runtime, initialPathname }: DashboardAppProps = {}) {
  return <XpodShellApp runtime={runtime} initialPathname={initialPathname} />;
}
