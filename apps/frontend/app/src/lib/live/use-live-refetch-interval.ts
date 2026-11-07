import { useLiveConnection } from '@/lib/live/use-live-connection';

/**
 * While the EventSource stream is up (or still connecting), rely on
 * invalidate/resync only. After sustained disconnect (`paused`), fall back
 * to a slow safety refetch so the console does not go silent forever.
 */
export function useLiveRefetchInterval(degradedMs = 60_000): number | false {
  const { status } = useLiveConnection();
  return status === 'paused' ? degradedMs : false;
}
