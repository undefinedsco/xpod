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
      header={mounted.slots.header}
      list={mounted.slots.list}
      main={mounted.slots.main}
      mode="auto"
    />
  );
}
