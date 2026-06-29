import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

export function PendingChangesPanel(props: {
  changes: Array<{ key: string; from: string; to: string }>;
  onReset: () => void;
}) {
  const { changes, onReset } = props;

  return (
    <Card variant="bordered" className="mb-6">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-4">
          <CardTitle>待应用变更</CardTitle>
          <Button type="button" variant="ghost" size="sm" onClick={onReset} disabled={changes.length === 0}>
            重置未保存
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {changes.length === 0 ? (
          <p className="text-sm text-muted-foreground">没有未保存的变更。</p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-amber-700 dark:text-amber-300">保存后需要重启运行时才能完全生效。</p>
            <div className="divide-y divide-border rounded-md border border-border">
              {changes.map((change) => (
                <div key={change.key} className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[180px_1fr]">
                  <span className="font-mono text-xs text-muted-foreground">{change.key}</span>
                  <span className="font-mono text-xs text-foreground break-all">
                    {change.from || '∅'} → {change.to || '∅'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
