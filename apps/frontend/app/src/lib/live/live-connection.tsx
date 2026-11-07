import {
  LiveConnectionContext,
  type LiveConnectionValue,
} from '@/lib/live/live-connection-context';
import type { ReactNode } from 'react';

export function LiveConnectionProvider({
  value,
  children,
}: {
  value: LiveConnectionValue;
  children: ReactNode;
}) {
  return (
    <LiveConnectionContext.Provider value={value}>
      {children}
    </LiveConnectionContext.Provider>
  );
}
