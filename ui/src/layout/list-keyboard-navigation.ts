export function handleListNavigationKeyDown(event: {
  key: string;
  currentTarget: HTMLElement;
  preventDefault(): void;
}): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const container = event.currentTarget.closest('[data-list-navigation]') ?? event.currentTarget.closest('nav');
  if (!container) return;
  const links = [...container.querySelectorAll<HTMLElement>('a[href]:not([aria-disabled="true"])')];
  const current = links.indexOf(event.currentTarget);
  if (current < 0 || links.length === 0) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? links.length - 1
      : event.key === 'ArrowDown' ? (current + 1) % links.length
        : (current - 1 + links.length) % links.length;
  links[next]?.focus();
}
