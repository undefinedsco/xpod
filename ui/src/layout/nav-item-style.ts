export const navItemBaseClass = 'rounded-lg transition-colors';

export const navItemInteractiveClass = 'text-foreground hover:bg-accent/60';

export const navItemFocusClass = 'focus:outline-none focus:ring-0 focus-visible:bg-accent/70';

export function getNavItemClass(isActive: boolean, options?: { compact?: boolean; muted?: boolean; basePx?: number }) {
  const compact = options?.compact === true;
  const muted = options?.muted === true;
  return [
    navItemBaseClass,
    navItemFocusClass,
    muted ? 'text-muted-foreground' : 'text-foreground',
    isActive ? 'bg-accent text-accent-foreground' : '',
    compact ? 'mx-2 flex items-center gap-3 rounded-lg px-2 py-2 text-sm' : 'mx-2 flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm',
    isActive ? '' : navItemInteractiveClass,
  ].join(' ');
}

/**
 * 64px rail 中的图标入口；窄窗在抽屉里复用同一棵导航树。
 *
 * The rail column is a fixed 64px physical strip, so its controls must keep a
 * fixed physical footprint too: rem-based sizing grows the hit-box to 80px at
 * 200% root text and clips it against the 64px rail. Use physical px here so the
 * control and its focus state stay fully inside the rail at any text scale.
 */
export function getRailNavItemClass(isActive: boolean) {
  return [
    navItemBaseClass,
    navItemFocusClass,
    isActive ? 'bg-accent text-accent-foreground' : `text-foreground ${navItemInteractiveClass}`,
    'relative flex h-[40px] w-[40px] items-center justify-center rounded-lg',
  ].join(' ');
}

export function getListNavItemClass(isActive: boolean, options?: { compact?: boolean }) {
  const compact = options?.compact === true;
  return [
    navItemBaseClass,
    navItemFocusClass,
    isActive ? 'bg-accent text-accent-foreground' : '',
    compact ? 'rounded-lg px-2 py-2' : 'rounded-lg px-3 py-2.5',
    'mx-2 flex items-center gap-3 text-sm transition-colors',
    isActive ? 'font-medium' : `${navItemInteractiveClass} text-foreground`,
  ].join(' ');
}
