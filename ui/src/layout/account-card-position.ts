import type { CSSProperties } from 'react';

export function accountCardPosition(
  trigger: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
  viewportWidth: number,
  viewportHeight: number,
): CSSProperties {
  const gutter = 8;
  const offset = 12;
  const width = Math.min(360, viewportWidth - gutter * 2);
  const top = Math.max(gutter, Math.min(trigger.top, viewportHeight - 240 - gutter));
  return {
    left: Math.max(gutter, Math.min(trigger.right + offset, viewportWidth - width - gutter)),
    top,
    width,
    maxHeight: Math.max(0, viewportHeight - top - gutter),
  };
}
