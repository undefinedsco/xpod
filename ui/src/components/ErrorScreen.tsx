import { AuthSurface, Button } from '@undefineds.co/shared-ui';

interface ErrorScreenProps {
  message: string;
}

export function ErrorScreen({ message }: ErrorScreenProps) {
  return (
    <AuthSurface mode="page" title="Something went wrong">
      <div className="space-y-4 p-4">
        <p role="alert" className="text-sm text-destructive">{message}</p>
        <Button type="button" className="w-full" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </div>
    </AuthSurface>
  );
}
