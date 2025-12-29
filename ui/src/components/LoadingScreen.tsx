import { Loader2 } from 'lucide-react';

export function LoadingScreen() {
  return (
    <div className="flex min-h-screen bg-zinc-50 text-zinc-900 items-center justify-center">
      <Loader2 className="w-6 h-6 animate-spin text-[#7C4DFF]" />
    </div>
  );
}
