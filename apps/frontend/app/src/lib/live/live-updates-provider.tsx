import { useAuth } from '@/lib/auth/auth-context';
import { connectLiveEvents, type LiveEventsHandle } from '@/lib/live/events';
import { LiveConnectionProvider } from '@/lib/live/live-connection';
import { type LiveConnectionStatus } from '@/lib/live/live-connection-context';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Opens the operator SSE bus while signed in. Exposes connection state so
 * hooks can enable a slow safety refetch only after sustained disconnect.
 */
export function LiveUpdatesProvider({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const queryClient = useQueryClient();
  const handleRef = useRef<LiveEventsHandle | null>(null);
  const generationRef = useRef(0);
  const [streamStatus, setStreamStatus] =
    useState<Exclude<LiveConnectionStatus, 'idle'>>('connecting');
  const authenticated = state.status === 'authenticated';

  useEffect(() => {
    if (!authenticated) {
      generationRef.current += 1;
      handleRef.current?.close();
      handleRef.current = null;
      return;
    }

    const generation = ++generationRef.current;
    const isCurrent = () => generationRef.current === generation;

    const start = () => {
      handleRef.current?.close();
      if (isCurrent()) {
        setStreamStatus('connecting');
      }
      handleRef.current = connectLiveEvents({
        queryClient,
        isCurrent,
        onConnectionChange: (connected) => {
          if (!isCurrent()) return;
          setStreamStatus(connected ? 'live' : 'paused');
        },
      });
    };

    const stop = () => {
      handleRef.current?.close();
      handleRef.current = null;
      if (isCurrent()) {
        // Tab hidden: pause without enabling the safety poll as "live down".
        setStreamStatus('connecting');
      }
    };

    const onVisibility = () => {
      if (document.hidden) {
        stop();
        return;
      }
      start();
    };

    if (!document.hidden) {
      start();
    } else if (isCurrent()) {
      setStreamStatus('connecting');
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      generationRef.current += 1;
      handleRef.current?.close();
      handleRef.current = null;
    };
  }, [authenticated, queryClient]);

  const status: LiveConnectionStatus = authenticated ? streamStatus : 'idle';

  const value = {
    status,
    connected: status === 'live',
  };

  return (
    <LiveConnectionProvider value={value}>{children}</LiveConnectionProvider>
  );
}
