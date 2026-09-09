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

export function getRailNavItemClass(isActive: boolean) {
  return [
    navItemBaseClass,
    navItemFocusClass,
    isActive ? 'bg-accent text-accent-foreground' : `text-foreground ${navItemInteractiveClass}`,
    'h-9 w-9 rounded-lg p-0',
    isActive ? '' : 'mx-2',
    'flex items-center justify-center',
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
