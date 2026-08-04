import { useEffect } from 'react';
import { TwoPaneLayout } from '@undefineds.co/extension-sdk/react';
import { useMountedAiConnectionApplet } from '../../extensions/ai-connection-host';
import { useXpodSolidRuntime } from '../../solid/useXpodSolidRuntime';

export default function ModelsPage() {
  const runtime = useXpodSolidRuntime();
  const mounted = useMountedAiConnectionApplet(runtime);

  useEffect(() => {
    void mounted.controller.ensureServiceAccess();
  }, [mounted.controller]);

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
