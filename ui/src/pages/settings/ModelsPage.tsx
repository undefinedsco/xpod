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
      mainHeader={mounted.slots.mainHeader}
      main={mounted.slots.main}
      mode="auto"
    />
  );
}
