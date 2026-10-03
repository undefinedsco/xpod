import { ShellHeaderControls } from '../../shell/ShellHeaderControls';
import { TwoPaneLayout } from '@undefineds.co/extension-sdk/react';
import { useMountedAiConnectionsApplet } from '../../extensions/ai-connections-host';
import { useXpodSolidRuntime } from '../../solid/useXpodSolidRuntime';

export default function ModelsPage() {
  const runtime = useXpodSolidRuntime();
  const mounted = useMountedAiConnectionsApplet(runtime);

  return (
    <TwoPaneLayout
      listHeader={mounted.slots.listHeader}
      list={mounted.slots.list}
      mainHeader={<div className="flex h-full min-w-0 items-center justify-between pr-3"><div className="min-w-0 flex-1">{mounted.slots.mainHeader}</div><ShellHeaderControls /></div>}
      main={mounted.slots.main}
      mode="auto"
    />
  );
}
