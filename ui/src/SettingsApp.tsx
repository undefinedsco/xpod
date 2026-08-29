import type { XpodSolidRuntimeCore } from './solid/XpodSolidRuntime';
import { XpodShellApp } from './XpodShellApp';

export interface SettingsAppProps {
  runtime?: XpodSolidRuntimeCore;
  initialPathname?: string;
}

export function SettingsApp({ runtime, initialPathname }: SettingsAppProps = {}) {
  return <XpodShellApp runtime={runtime} initialPathname={initialPathname} />;
}
