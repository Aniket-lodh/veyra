import {
  LiveConnectionContext,
  type LiveConnectionValue,
} from '@/lib/live/live-connection-context';
import { useContext } from 'react';

export function useLiveConnection(): LiveConnectionValue {
  return useContext(LiveConnectionContext);
}
