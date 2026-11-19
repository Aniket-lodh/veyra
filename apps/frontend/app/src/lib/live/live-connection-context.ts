import { createContext } from 'react';

export type LiveConnectionStatus = 'idle' | 'connecting' | 'live' | 'paused';

export type LiveConnectionValue = {
  /**
   * idle — signed out
   * connecting — EventSource opening / recovering briefly
   * live — stream delivering frames
   * paused — sustained disconnect; safety refetch active
   */
  status: LiveConnectionStatus;
  /** True only while status === 'live'. */
  connected: boolean;
};

export const LiveConnectionContext = createContext<LiveConnectionValue>({
  status: 'idle',
  connected: false,
});
