import xpodIconUrl from '../assets/xpod-shield.svg';

export function XpodLoginBrand({
  compact = false,
  showSubtitle = !compact,
  subtitle = '使用 WebID 登录',
}: {
  compact?: boolean;
  showSubtitle?: boolean;
  subtitle?: string;
}) {
  const expandedCompactBrand = compact && showSubtitle;

  return (
    <div
      data-testid="xpod-login-brand"
      data-presentation={compact ? 'compact' : 'standard'}
      className={expandedCompactBrand
        ? 'flex flex-col items-center justify-center gap-1 text-center'
        : compact
          ? 'flex items-center justify-center gap-2 text-center'
        : 'flex flex-col items-center gap-3 text-center'}
    >
      <img
        src={xpodIconUrl}
        alt=""
        className={compact ? (expandedCompactBrand ? 'h-16 w-16' : 'h-7 w-7') : 'h-11 w-11'}
      />
      <div className={expandedCompactBrand ? 'space-y-1 text-center' : compact ? 'text-left' : 'space-y-1'}>
        <h1 className={compact ? 'text-base font-semibold leading-none text-foreground' : 'text-lg font-semibold text-foreground'}>
          Xpod
        </h1>
        {showSubtitle ? <p className="text-xs text-primary/80">{subtitle}</p> : null}
      </div>
    </div>
  );
}
