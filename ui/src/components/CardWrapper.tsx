import type { ComponentType, ReactNode } from 'react';
import { AuthSurface, Button } from '@undefineds.co/shared-ui';

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
 * AuthSurface directly so they share the canonical presentation contract.
 */
export function CardWrapper({ children, title, subtitle, showBack, onBack }: CardWrapperProps) {
  return (
    <AuthSurface mode="page" title={title}>
      <div className="space-y-4 p-4">
        {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
        {children}
        {showBack && onBack ? (
          <Button type="button" variant="ghost" className="w-full" onClick={onBack}>
            Back
          </Button>
        ) : null}
      </div>
    </AuthSurface>
  );
}
