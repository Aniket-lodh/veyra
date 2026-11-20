import { queryKeys } from '@/hooks/api/query-keys';
import {
  parseLivePayload,
  type LiveEventName,
  type LiveResource,
} from '@/lib/live/payload';
import type { QueryClient } from '@tanstack/react-query';

export type { LiveEventName, LiveResource };
export { parseLivePayload };

const EVENTS_URL = '/events';

export function invalidateLiveResources(
  queryClient: QueryClient,
  resources: readonly LiveResource[],
): void {
  for (const resource of resources) {
    switch (resource) {
      case 'jobs':
        void queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
        break;
      case 'workers':
        void queryClient.invalidateQueries({
          queryKey: queryKeys.workers.all,
        });
        break;
      case 'stats':
        void queryClient.invalidateQueries({ queryKey: queryKeys.stats.all });
        break;
    }
  }
}

export type LiveEventsHandle = {
  close: () => void;
};

export type ConnectLiveOptions = {
  queryClient: QueryClient;
  onConnectionChange: (connected: boolean) => void;
  /** True while this connection is the active one for the provider. */
  isCurrent: () => boolean;
};

/**
 * Opens same-origin GET /events via native EventSource (credentials included).
 * Server `retry` + Last-Event-ID drive resume; resync frames repair gaps.
 */
export function connectLiveEvents(
  options: ConnectLiveOptions,
): LiveEventsHandle {
  const { queryClient, onConnectionChange, isCurrent } = options;
  let closed = false;
  let source: EventSource | null = null;
  let errorSince: number | null = null;

  const setConnected = (connected: boolean) => {
    if (closed || !isCurrent()) return;
    onConnectionChange(connected);
  };

  const onFrame = (name: LiveEventName) => (evt: Event) => {
    if (closed || !isCurrent()) return;
    setConnected(true);
    errorSince = null;
    const resources = parseLivePayload((evt as MessageEvent).data);
    if (resources) {
      invalidateLiveResources(queryClient, resources);
    } else if (name === 'resync') {
      invalidateLiveResources(queryClient, ['jobs', 'workers', 'stats']);
    }
  };

  const open = () => {
    if (closed || !isCurrent()) return;
    source?.close();
    source = new EventSource(EVENTS_URL);

    source.addEventListener('invalidate', onFrame('invalidate'));
    source.addEventListener('resync', onFrame('resync'));

    source.onopen = () => {
      if (closed || !isCurrent()) return;
      setConnected(true);
      errorSince = null;
    };

    source.onerror = () => {
      if (closed || !isCurrent()) return;
      // EventSource auto-reconnects using the server retry field.
      if (source?.readyState === EventSource.CLOSED) {
        setConnected(false);
        errorSince = Date.now();
        return;
      }
      // CONNECTING: transient; mark disconnected only after sustained failure.
      if (errorSince === null) {
        errorSince = Date.now();
      }
      if (Date.now() - errorSince > 15_000) {
        setConnected(false);
      }
    };
  };

  open();

  return {
    close: () => {
      closed = true;
      source?.close();
      source = null;
    },
  };
}
