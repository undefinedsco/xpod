import { AlertCircle } from 'lucide-react';
import { CardWrapper } from './CardWrapper';

interface ErrorScreenProps {
  message: string;
}

export function ErrorScreen({ message }: ErrorScreenProps) {
  return (
    <CardWrapper title="Error" subtitle={message} icon={AlertCircle}>
      <button onClick={() => window.location.reload()} className="w-full py-2.5 bg-zinc-800 hover:bg-zinc-700 rounded-xl text-xs font-medium transition-colors">
        Retry
      </button>
    </CardWrapper>
  );
}
