import { Card as SharedCard } from '@undefineds.co/shared-ui';
import type { ComponentProps } from 'react';

export { CardHeader, CardTitle, CardContent } from '@undefineds.co/shared-ui';

// Legacy callers requested an explicit border; the shared card already owns it.
export function Card({ variant, ...props }: ComponentProps<typeof SharedCard> & { variant?: 'bordered' }) {
  void variant;
  return <SharedCard {...props} />;
}
