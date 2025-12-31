import { useNavigate } from 'react-router-dom';
import { Clock, Layers, Shield, ArrowLeft, ExternalLink } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export function AboutPage() {
  const navigate = useNavigate();
  const { isLoggedIn } = useAuth();

  const features = [
    { icon: Clock, title: 'Your AI Never Stops', desc: 'Runs 24/7, even when you\'re not talking to it' },
    { icon: Layers, title: 'One Place for Your Whole Life', desc: 'All your messages together in one place' },
    { icon: Shield, title: 'One Secretary, A Thousand Agents', desc: 'Full power, full privacy' },
  ];

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 font-sans flex items-center justify-center p-4 lg:p-8">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-[800px] h-[600px] bg-[#7C4DFF]/5 rounded-full blur-[150px]" />
        <div className="absolute bottom-0 right-1/4 w-[600px] h-[400px] bg-[#7C4DFF]/3 rounded-full blur-[100px]" />
      </div>

      <div className="w-full max-w-6xl grid lg:grid-cols-2 gap-8 lg:gap-16 items-center relative z-10">
        {/* Left - Brand (same as WelcomePage) */}
        <div className="hidden lg:block px-8">
          <div className="max-w-md ml-auto">
            <div className="flex items-center gap-3 mb-8">
              <div className="w-12 h-12 bg-[#7C4DFF] rounded-xl shadow-lg shadow-[#7C4DFF]/20 flex items-center justify-center">
                <div className="w-6 h-6 border-2 border-white rounded opacity-90" />
              </div>
              <div>
                <div className="text-2xl font-bold leading-tight">Xpod</div>
                <div className="text-[10px] text-zinc-500 leading-tight">Personal Messages Platform</div>
              </div>
            </div>

            <h1 className="text-2xl xl:text-3xl font-bold leading-tight mb-4">
              Simplify Life with <span className="text-[#7C4DFF]">Your AI Secretary</span>
            </h1>
            <p className="text-zinc-500 text-sm leading-relaxed mb-10">
              An AI that never stops, knows your whole life, works for you—while guarding your privacy.
            </p>

            <div className="space-y-4">
              <div className="space-y-3">
                {features.map(({ icon: Icon, title, desc }) => (
                  <div key={title} className="flex gap-3">
                    <div className="w-8 h-8 bg-white border border-zinc-200 rounded-lg flex items-center justify-center shrink-0 shadow-sm">
                      <Icon className="w-4 h-4 text-[#7C4DFF]" />
                    </div>
                    <div>
                      <h3 className="text-xs font-medium text-zinc-900">{title}</h3>
                      <p className="text-[10px] text-zinc-500">{desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            
            <div className="mt-12">
              <p className="text-[10px] text-zinc-400">
                Powered by <a href="https://solidproject.org" target="_blank" rel="noopener" className="text-[#7C4DFF] hover:text-[#6B3FE8]">Solid Protocol</a>
              </p>
            </div>
          </div>
        </div>

        {/* Right - About Info Card */}
        <div className="w-full max-w-sm mx-auto lg:mx-0">
          <div className="bg-white border border-zinc-200 rounded-3xl p-6 lg:p-8 shadow-xl shadow-zinc-200/50">
            {/* Mobile header */}
            <div className="lg:hidden flex items-center gap-3 mb-8">
              <div className="w-10 h-10 bg-[#7C4DFF] rounded-xl flex items-center justify-center">
                <div className="w-5 h-5 border-2 border-white rounded opacity-90" />
              </div>
              <div>
                <div className="text-xl font-bold leading-tight">Xpod</div>
                <div className="text-[10px] text-zinc-500 leading-tight">Personal Messages Platform</div>
              </div>
            </div>

            {/* Mobile features */}
            <div className="lg:hidden mb-8">
              <h1 className="text-xl font-bold leading-tight mb-3">
                Simplify Life with <span className="text-[#7C4DFF]">Your AI Secretary</span>
              </h1>
              <p className="text-zinc-500 text-xs leading-relaxed mb-6">
                An AI that never stops, knows your whole life, works for you—while guarding your privacy.
              </p>
              <div className="space-y-2">
                {features.map(({ icon: Icon, title, desc }) => (
                  <div key={title} className="flex gap-2">
                    <Icon className="w-4 h-4 text-[#7C4DFF] shrink-0 mt-0.5" />
                    <div>
                      <span className="text-xs font-medium text-zinc-900">{title}</span>
                      <span className="text-xs text-zinc-500"> - {desc}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mb-6">
              <h2 className="text-xl font-bold">About Xpod</h2>
              <p className="text-zinc-500 text-xs mt-1">
                Learn more about the platform and resources.
              </p>
            </div>

            <div className="space-y-3 mb-6">
              <a 
                href="https://solidproject.org" 
                target="_blank" 
                rel="noopener noreferrer"
                className="flex items-center gap-3 p-3 bg-zinc-50 border border-zinc-200 rounded-xl hover:border-[#7C4DFF]/50 transition-colors group"
              >
                <div className="w-8 h-8 bg-white border border-zinc-200 rounded-lg flex items-center justify-center">
                  <ExternalLink className="w-4 h-4 text-zinc-400 group-hover:text-[#7C4DFF]" />
                </div>
                <div>
                  <div className="text-sm font-medium text-zinc-900">Solid Project</div>
                  <div className="text-xs text-zinc-500">Learn about the protocol</div>
                </div>
              </a>
              <a 
                href="https://github.com" 
                target="_blank" 
                rel="noopener noreferrer"
                className="flex items-center gap-3 p-3 bg-zinc-50 border border-zinc-200 rounded-xl hover:border-[#7C4DFF]/50 transition-colors group"
              >
                <div className="w-8 h-8 bg-white border border-zinc-200 rounded-lg flex items-center justify-center">
                  <ExternalLink className="w-4 h-4 text-zinc-400 group-hover:text-[#7C4DFF]" />
                </div>
                <div>
                  <div className="text-sm font-medium text-zinc-900">GitHub</div>
                  <div className="text-xs text-zinc-500">View source code</div>
                </div>
              </a>
            </div>

            <div className="pt-4 border-t border-zinc-100">
              <p className="text-[10px] text-zinc-400 mb-4">
                Version 0.1.0 · Built with Solid Protocol
              </p>
              <button
                onClick={() => navigate(isLoggedIn ? '/.account/account/' : '/.account/login/password/')}
                className="w-full py-3 border border-zinc-200 hover:bg-zinc-50 text-zinc-700 rounded-xl text-sm font-medium flex items-center justify-center gap-2 transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
                {isLoggedIn ? 'Back to Dashboard' : 'Back to Login'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
