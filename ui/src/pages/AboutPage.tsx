import { useNavigate } from 'react-router-dom';
import { Clock, Layers, Shield, ArrowLeft, ExternalLink } from 'lucide-react';
import { useAuth } from '../context/AuthContextValue';

const brandTileClass = 'flex items-center justify-center rounded-xl bg-primary text-primary-foreground';
const iconTileClass = 'bg-card border border-border rounded-lg flex items-center justify-center shadow-sm';
const resourceLinkClass = 'flex items-center gap-3 p-3 bg-muted border border-border rounded-xl hover:border-primary/50 transition-colors group';

export function AboutPage() {
  const navigate = useNavigate();
  const { isLoggedIn } = useAuth();

  const features = [
    { icon: Clock, title: 'Your AI Secretary Never Stops', desc: 'Runs 24/7, even when you\'re not talking to it' },
    { icon: Layers, title: 'One Place for Your Whole Life', desc: 'All your messages together in one place' },
    { icon: Shield, title: 'One Secretary, Many Agents', desc: 'Full power, full privacy' },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground font-sans flex items-center justify-center p-4 lg:p-8">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-[800px] h-[600px] bg-primary/5 rounded-full blur-[150px]" />
        <div className="absolute bottom-0 right-1/4 w-[600px] h-[400px] bg-primary/5 rounded-full blur-[100px]" />
      </div>

      <div className="w-full max-w-6xl grid lg:grid-cols-2 gap-8 lg:gap-16 items-center relative z-10">
        {/* Left - Brand (same as WelcomePage) */}
        <div className="hidden lg:block px-8">
          <div className="max-w-md ml-auto">
            <div className="flex items-center gap-3 mb-8">
              <div className={`w-12 h-12 shadow-lg shadow-primary/20 ${brandTileClass}`}>
                <div className="w-6 h-6 border-2 border-primary-foreground rounded opacity-90" />
              </div>
              <div>
                <div className="text-2xl font-bold leading-tight">Xpod</div>
                <div className="text-[10px] text-muted-foreground leading-tight">Personal Messages Platform</div>
              </div>
            </div>

            <h1 className="text-2xl xl:text-3xl font-bold leading-tight mb-4">
              Simplify Life with <span className="text-primary">Your AI Secretary</span>
            </h1>
            <p className="text-muted-foreground text-sm leading-relaxed mb-10">
              An AI that never stops, knows your whole life, works for you—while guarding your privacy.
            </p>

            <div className="space-y-4">
              <div className="space-y-3">
                {features.map(({ icon: Icon, title, desc }) => (
                  <div key={title} className="flex gap-3">
                    <div className={`w-8 h-8 shrink-0 ${iconTileClass}`}>
                      <Icon className="w-4 h-4 text-primary" />
                    </div>
                    <div>
                      <h3 className="text-xs font-medium text-foreground">{title}</h3>
                      <p className="text-[10px] text-muted-foreground">{desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            
            <div className="mt-12">
              <p className="text-[10px] text-muted-foreground">
                Powered by <a href="https://solidproject.org" target="_blank" rel="noopener" className="text-primary hover:text-primary/80">Solid Protocol</a>
              </p>
            </div>
          </div>
        </div>

        {/* Right - About Info Card */}
        <div className="w-full max-w-sm mx-auto lg:mx-0">
          <div className="bg-card border border-border rounded-3xl p-6 lg:p-8 shadow-xl shadow-black/10">
            {/* Mobile header */}
            <div className="lg:hidden flex items-center gap-3 mb-8">
              <div className={`w-10 h-10 ${brandTileClass}`}>
                <div className="w-5 h-5 border-2 border-primary-foreground rounded opacity-90" />
              </div>
              <div>
                <div className="text-xl font-bold leading-tight">Xpod</div>
                <div className="text-[10px] text-muted-foreground leading-tight">Personal Messages Platform</div>
              </div>
            </div>

            {/* Mobile features */}
            <div className="lg:hidden mb-8">
              <h1 className="text-xl font-bold leading-tight mb-3">
                Simplify Life with <span className="text-primary">Your AI Secretary</span>
              </h1>
              <p className="text-muted-foreground text-xs leading-relaxed mb-6">
                An AI that never stops, knows your whole life, works for you—while guarding your privacy.
              </p>
              <div className="space-y-2">
                {features.map(({ icon: Icon, title, desc }) => (
                  <div key={title} className="flex gap-2">
                    <Icon className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                    <div>
                      <span className="text-xs font-medium text-foreground">{title}</span>
                      <span className="text-xs text-muted-foreground"> - {desc}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mb-6">
              <h2 className="text-xl font-bold">About Xpod</h2>
              <p className="text-muted-foreground text-xs mt-1">
                Learn more about the platform and resources.
              </p>
            </div>

            <div className="space-y-3 mb-6">
              <a 
                href="https://solidproject.org" 
                target="_blank" 
                rel="noopener noreferrer"
                className={resourceLinkClass}
              >
                <div className={`w-8 h-8 ${iconTileClass}`}>
                  <ExternalLink className="w-4 h-4 text-muted-foreground group-hover:text-primary" />
                </div>
                <div>
                  <div className="text-sm font-medium text-foreground">Solid Project</div>
                  <div className="text-xs text-muted-foreground">Learn about the protocol</div>
                </div>
              </a>
              <a 
                href="https://github.com" 
                target="_blank" 
                rel="noopener noreferrer"
                className={resourceLinkClass}
              >
                <div className={`w-8 h-8 ${iconTileClass}`}>
                  <ExternalLink className="w-4 h-4 text-muted-foreground group-hover:text-primary" />
                </div>
                <div>
                  <div className="text-sm font-medium text-foreground">GitHub</div>
                  <div className="text-xs text-muted-foreground">View source code</div>
                </div>
              </a>
            </div>

            <div className="pt-4 border-t border-border">
              <p className="text-[10px] text-muted-foreground mb-4">
                Version 0.1.0 · Built with Solid Protocol
              </p>
              <button
                onClick={() => navigate(isLoggedIn ? '/.account/account/' : '/.account/login/password/')}
                className="w-full py-3 border border-border hover:bg-muted text-foreground rounded-xl text-sm font-medium flex items-center justify-center gap-2 transition-colors"
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
