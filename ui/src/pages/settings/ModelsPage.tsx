import { useEffect } from 'react';
import { TwoPaneLayout } from '@undefineds.co/extension-sdk/react';
import { useMountedAiConnectionApplet } from '../../extensions/ai-connection-host';
import { useXpodSolidRuntime } from '../../solid/useXpodSolidRuntime';
import { useAuth } from '../../context/AuthContextValue';

export default function ModelsPage() {
  const runtime = useXpodSolidRuntime();
  const { controls } = useAuth();
  const mounted = useMountedAiConnectionApplet(runtime, controls?.account?.clientCredentials);

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
