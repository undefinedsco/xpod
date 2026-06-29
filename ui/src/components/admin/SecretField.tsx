import { KeyRound } from 'lucide-react';
import { Input, Label } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { clsx } from 'clsx';

export function SecretField(props: {
  id: string;
  label: string;
  configured: boolean;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  helper?: string;
}) {
  const { id, label, configured, value, onChange, placeholder, helper } = props;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        <span
          className={clsx(
            'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs',
            configured ? 'border-green-200 text-green-700 dark:border-green-900 dark:text-green-300' : 'border-border text-muted-foreground',
          )}
        >
          <KeyRound className="h-3.5 w-3.5" />
          {configured ? '已配置' : '未配置'}
        </span>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id={id}
          type="password"
          autoComplete="new-password"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder ?? '填写新 secret'}
          aria-describedby={helper ? `${id}-helper` : undefined}
        />
        {value ? (
          <Button type="button" variant="ghost" onClick={() => onChange('')} className="shrink-0">
            清除替换值
          </Button>
        ) : null}
      </div>
      {helper ? <p id={`${id}-helper`} className="text-xs text-muted-foreground">{helper}</p> : null}
    </div>
  );
}
