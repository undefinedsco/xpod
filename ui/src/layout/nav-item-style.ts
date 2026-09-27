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
 * 宽窗口的文字导航行（spec §3.1「文字导航 + 内容」、§8.3 的 184px 导航）。
 * 窄窗口下同一棵树横向排列，因此这里只定宽窗口内的行形态。
 */
export function getRailNavItemClass(isActive: boolean) {
  return [
    navItemBaseClass,
    navItemFocusClass,
    isActive ? 'bg-accent text-accent-foreground' : `text-foreground ${navItemInteractiveClass}`,
    'mx-2 flex h-9 items-center gap-3 rounded-lg px-3',
    'md:w-[calc(100%-1rem)]',
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
