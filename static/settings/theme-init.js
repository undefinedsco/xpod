(() => {
  const storageKey = 'xpod.theme';
  let preference = 'system';
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === 'light' || stored === 'dark') preference = stored;
  } catch {
    // System theme remains the safe default when storage is unavailable.
  }
  const theme = preference === 'system'
    ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : preference;
  const root = document.documentElement;
  root.classList.remove(theme === 'dark' ? 'light' : 'dark');
  root.classList.add(theme);
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
})();
