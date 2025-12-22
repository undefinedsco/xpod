import { ArrowLeft } from 'lucide-react';

interface CardWrapperProps {
  children: React.ReactNode;
  title: string;
  subtitle?: string;
  icon?: React.ComponentType<{ className?: string }>;
  showBack?: boolean;
  onBack?: () => void;
}

export function CardWrapper({ children, title, subtitle, icon: Icon, showBack, onBack }: CardWrapperProps) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans flex items-center justify-center p-4">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[500px] bg-violet-600/5 rounded-full blur-[120px] opacity-40" />
      </div>
      <div className="w-full max-w-[360px] bg-zinc-900/40 backdrop-blur-2xl border border-zinc-800/50 rounded-3xl shadow-2xl p-6 relative z-10">
        <div className="flex flex-col items-center mb-6">
          <div className="flex w-full items-center justify-between mb-4">
            {showBack ? (
              <button onClick={onBack} className="p-2 -ml-2 rounded-full hover:bg-zinc-800/50 text-zinc-400 hover:text-white transition-colors">
                <ArrowLeft className="w-4 h-4" />
              </button>
            ) : <div className="w-8" />}
            <div className="w-10 h-10 bg-violet-600 rounded-xl shadow-lg shadow-violet-500/20 flex items-center justify-center">
              {Icon ? <Icon className="w-5 h-5 text-white" /> : <div className="w-5 h-5 border-2 border-white rounded opacity-80" />}
            </div>
            <div className="w-8" />
          </div>
          <h2 className="text-xl font-bold tracking-tight text-center">{title}</h2>
          {subtitle && <p className="mt-1 text-zinc-400 text-[11px] text-center leading-relaxed">{subtitle}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}
