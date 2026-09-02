import type { ComponentType, ReactNode } from 'react';
import { Button } from '@undefineds.co/shared-ui';
import { XpodAuthSurface } from '../auth/XpodAuthSurface';

interface CardWrapperProps {
  children: ReactNode;
  title: string;
  subtitle?: string;
  icon?: ComponentType<{ className?: string }>;
  showBack?: boolean;
  onBack?: () => void;
}

/**
 * Compatibility wrapper for non-migrated pages. New identity pages render
 * XpodAuthSurface directly so they share the product's single presentation.
 */
export function CardWrapper({ children, title, subtitle, showBack, onBack }: CardWrapperProps) {
  return (
    <XpodAuthSurface mode="page" title={title}>
      <div className="space-y-4 p-4">
        {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
        {children}
        {showBack && onBack ? (
          <Button type="button" variant="ghost" className="w-full" onClick={onBack}>
            Back
          </Button>
        ) : null}
      </div>
    </XpodAuthSurface>
  );
}
