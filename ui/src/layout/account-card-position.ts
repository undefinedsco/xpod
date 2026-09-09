import type { CSSProperties } from 'react';

export function accountCardPosition(
  trigger: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
  viewportWidth: number,
  viewportHeight: number,
): CSSProperties {
  const gutter = 8;
  const offset = 12;
  const bottomNavigationHeight = 64;
  const desktop = viewportWidth >= 640;
  const width = Math.min(360, viewportWidth - gutter * 2);
  if (desktop) {
    const top = Math.max(gutter, Math.min(trigger.top, viewportHeight - 240 - gutter));
    return {
      left: Math.max(gutter, Math.min(trigger.right + offset, viewportWidth - width - gutter)),
      top,
      width,
      maxHeight: Math.max(240, viewportHeight - top - gutter),
    };
  }

  const bottom = Math.max(bottomNavigationHeight + gutter, viewportHeight - trigger.top + offset);
  return {
    left: gutter,
    bottom,
    width,
    maxHeight: Math.max(240, viewportHeight - bottom - gutter),
  };
}
