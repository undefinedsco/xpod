import { createRoot } from 'react-dom/client';
import { XpodOidcCallbackApp } from './solid/XpodOidcCallbackApp';
import { createXpodSolidRuntimeValue } from './solid/XpodSolidRuntime';

// A full-page OIDC redirect creates one fresh document. Keep one Xpod runtime
// and one Inrupt Session adapter for this callback document only.
const runtime = createXpodSolidRuntimeValue();

createRoot(document.getElementById('root')!).render(
  <XpodOidcCallbackApp runtime={runtime} />,
);
