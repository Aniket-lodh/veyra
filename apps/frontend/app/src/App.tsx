import { AuthScreen } from '@/components/auth/auth-screen';
import { AuthProvider, useAuth } from '@/lib/auth/auth-context';
import { registerAuthRequiredNotifier } from '@/lib/auth/auth-events';
import { LiveUpdatesProvider } from '@/lib/live/live-updates-provider';
import { router } from '@/router';
import { useEffect } from 'react';
import { RouterProvider } from 'react-router-dom';

function AuthBridge({ children }: { children: React.ReactNode }) {
  const { state, onSessionExpired } = useAuth();

  useEffect(() => {
    registerAuthRequiredNotifier(onSessionExpired);
    return () => registerAuthRequiredNotifier(() => {});
  }, [onSessionExpired]);

  if (state.status === 'loading') {
    return (
      <div className="text-muted-foreground flex min-h-dvh items-center justify-center text-sm">
        Loading…
      </div>
    );
  }

  if (state.status === 'bootstrap' || state.status === 'unauthenticated') {
    return <AuthScreen />;
  }

  return <LiveUpdatesProvider>{children}</LiveUpdatesProvider>;
}

function App() {
  return (
    <AuthProvider>
      <AuthBridge>
        <RouterProvider router={router} />
      </AuthBridge>
    </AuthProvider>
  );
}

export default App;
