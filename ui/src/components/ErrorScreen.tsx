import { AlertCircle } from 'lucide-react';
import { CardWrapper } from './CardWrapper';

interface ErrorScreenProps {
  message: string;
}

export function ErrorScreen({ message }: ErrorScreenProps) {
  return (
    <CardWrapper title="Error" subtitle={message} icon={AlertCircle}>
      <button onClick={() => window.location.reload()} className="w-full py-2.5 bg-[#7C4DFF] hover:bg-[#6B3FE8] text-white rounded-xl text-xs font-medium transition-colors">
        Retry
      </button>
    </CardWrapper>
  );
}
