import type { Worker } from './types';

export type WorkerLifecycleStatus =
  | 'busy'
  | 'idle'
  | 'draining'
  | 'stale'
  | 'disconnected';

export type WorkerFilterTab =
  | 'all'
  | 'busy'
  | 'idle'
  | 'stale'
  | 'disconnected';

export type WorkerSortOption =
  | 'heartbeat_desc'
  | 'heartbeat_asc'
  | 'utilization_desc'
  | 'processed_desc'
  | 'hostname_asc';

export interface FleetMetrics {
  totalWorkers: number;
  busyWorkers: number;
  idleWorkers: number;
  drainingWorkers: number;
  staleWorkers: number;
  disconnectedWorkers: number;
  activeFleetWorkers: number;
  totalInFlight: number;
  totalCapacity: number;
  utilizationPct: number;
}

export interface FilterWorkersOptions {
  tab?: WorkerFilterTab;
  queue?: string;
  query?: string;
  sortBy?: WorkerSortOption;
  now?: number;
}

/**
 * Determines whether a worker's heartbeat is older than 3× its expected interval.
 */
export function isHeartbeatStale(
  lastHeartbeatAt: string,
  heartbeatIntervalSeconds: number,
  now: number = Date.now(),
): boolean {
  const last = Date.parse(lastHeartbeatAt);
  if (Number.isNaN(last)) return false;
  const ageMs = now - last;
  return ageMs > heartbeatIntervalSeconds * 3 * 1000;
}

/**
 * Returns how long a heartbeat has been overdue past the 3x stale threshold in milliseconds.
 * Returns 0 if not overdue.
 */
export function getHeartbeatOverdueDurationMs(
  lastHeartbeatAt: string,
  heartbeatIntervalSeconds: number,
  now: number = Date.now(),
): number {
  const last = Date.parse(lastHeartbeatAt);
  if (Number.isNaN(last)) return 0;
  const thresholdMs = heartbeatIntervalSeconds * 3 * 1000;
  const ageMs = now - last;
  return Math.max(0, ageMs - thresholdMs);
}

/**
 * Resolves a worker's operational lifecycle status.
 *
 * Precedence:
 * 1. disconnected (sweeper or graceful shutdown in DB)
 * 2. stale (heartbeat age > 3x interval, runtime degraded/unresponsive)
 * 3. draining (finishing in-flight work before stopping)
 * 4. busy (in-flight jobs > 0)
 * 5. idle (healthy, in-flight === 0, ready for work)
 */
export function getWorkerLifecycle(
  worker: Worker,
  now: number = Date.now(),
): WorkerLifecycleStatus {
  if (worker.state === 'disconnected') {
    return 'disconnected';
  }
  if (
    isHeartbeatStale(
      worker.lastHeartbeatAt,
      worker.heartbeatIntervalSeconds,
      now,
    )
  ) {
    return 'stale';
  }
  if (worker.state === 'draining') {
    return 'draining';
  }
  if (worker.inFlight > 0) {
    return 'busy';
  }
  return 'idle';
}

/**
 * Returns semantic badge properties for a worker lifecycle status.
 */
export function getWorkerStatusBadgeProps(status: WorkerLifecycleStatus): {
  label: string;
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'muted';
  dotColorClass: string;
  description: string;
} {
  switch (status) {
    case 'busy':
      return {
        label: 'Busy',
        tone: 'success',
        dotColorClass: 'bg-status-success-solid',
        description: 'Actively processing jobs under a healthy heartbeat.',
      };
    case 'idle':
      return {
        label: 'Idle',
        tone: 'neutral',
        dotColorClass: 'bg-status-neutral-solid',
        description: 'Online and waiting to claim available queue work.',
      };
    case 'draining':
      return {
        label: 'Draining',
        tone: 'info',
        dotColorClass: 'bg-status-info-solid',
        description: 'Cordoned: finishing in-flight jobs before shutting down.',
      };
    case 'stale':
      return {
        label: 'Degraded (Stale)',
        tone: 'warning',
        dotColorClass: 'bg-status-warning-solid',
        description:
          'Heartbeat overdue past 3× interval. Worker process may have crashed or lost network connectivity.',
      };
    case 'disconnected':
      return {
        label: 'Disconnected',
        tone: 'danger',
        dotColorClass: 'bg-status-danger-solid',
        description:
          'Deregistered or transitioned to offline by background sweeper.',
      };
  }
}

/**
 * Computes fleet health & capacity metrics across all workers.
 *
 * CRITICAL INVARIANT:
 * Disconnected workers are excluded from totalCapacity and Fleet Utilization %
 * so offline historical records do not distort live fleet capacity.
 */
export function computeFleetMetrics(
  workers: Worker[],
  now: number = Date.now(),
): FleetMetrics {
  let busyWorkers = 0;
  let idleWorkers = 0;
  let drainingWorkers = 0;
  let staleWorkers = 0;
  let disconnectedWorkers = 0;
  let activeFleetWorkers = 0;
  let totalInFlight = 0;
  let totalCapacity = 0;

  for (const w of workers) {
    const lifecycle = getWorkerLifecycle(w, now);
    switch (lifecycle) {
      case 'busy':
        busyWorkers++;
        break;
      case 'idle':
        idleWorkers++;
        break;
      case 'draining':
        drainingWorkers++;
        break;
      case 'stale':
        staleWorkers++;
        break;
      case 'disconnected':
        disconnectedWorkers++;
        break;
    }

    // Exclude disconnected workers from active capacity & in-flight metrics
    if (w.state !== 'disconnected') {
      activeFleetWorkers++;
      totalCapacity += Math.max(0, w.maxConcurrency);
      totalInFlight += Math.max(0, w.inFlight);
    }
  }

  const utilizationPct =
    totalCapacity > 0
      ? Math.min(100, Math.round((totalInFlight / totalCapacity) * 1000) / 10)
      : 0;

  return {
    totalWorkers: workers.length,
    busyWorkers,
    idleWorkers,
    drainingWorkers,
    staleWorkers,
    disconnectedWorkers,
    activeFleetWorkers,
    totalInFlight,
    totalCapacity,
    utilizationPct,
  };
}

/**
 * Extracts a unique, sorted list of queues across all workers.
 */
export function extractAllQueues(workers: Worker[]): string[] {
  const set = new Set<string>();
  for (const w of workers) {
    for (const q of w.queues) {
      if (q.trim()) set.add(q.trim());
    }
  }
  return Array.from(set).sort();
}

/**
 * Filters and sorts workers based on tab, queue, search query, and sort criteria.
 */
export function filterAndSortWorkers(
  workers: Worker[],
  options: FilterWorkersOptions = {},
): Worker[] {
  const {
    tab = 'all',
    queue = 'all',
    query = '',
    sortBy = 'heartbeat_desc',
    now = Date.now(),
  } = options;

  const normalizedQuery = query.trim().toLowerCase();

  const filtered = workers.filter((w) => {
    // 1. Tab filter
    if (tab !== 'all') {
      const lifecycle = getWorkerLifecycle(w, now);
      if (tab === 'busy' && lifecycle !== 'busy') return false;
      if (tab === 'idle' && lifecycle !== 'idle') return false;
      if (tab === 'stale' && lifecycle !== 'stale') return false;
      if (tab === 'disconnected' && lifecycle !== 'disconnected') return false;
    }

    // 2. Queue filter
    if (queue !== 'all') {
      if (!w.queues.includes(queue)) return false;
    }

    // 3. Search query
    if (normalizedQuery) {
      const matchHostname = w.hostname.toLowerCase().includes(normalizedQuery);
      const matchId = w.id.toLowerCase().includes(normalizedQuery);
      const matchPid = w.pid.toString().includes(normalizedQuery);
      const matchVersion = w.version.toLowerCase().includes(normalizedQuery);
      if (!matchHostname && !matchId && !matchPid && !matchVersion) {
        return false;
      }
    }

    return true;
  });

  return filtered.sort((a, b) => {
    switch (sortBy) {
      case 'heartbeat_desc': {
        const timeA = Date.parse(a.lastHeartbeatAt) || 0;
        const timeB = Date.parse(b.lastHeartbeatAt) || 0;
        return timeB - timeA;
      }
      case 'heartbeat_asc': {
        const timeA = Date.parse(a.lastHeartbeatAt) || 0;
        const timeB = Date.parse(b.lastHeartbeatAt) || 0;
        return timeA - timeB;
      }
      case 'utilization_desc': {
        const utilA = a.maxConcurrency > 0 ? a.inFlight / a.maxConcurrency : 0;
        const utilB = b.maxConcurrency > 0 ? b.inFlight / b.maxConcurrency : 0;
        if (utilB !== utilA) return utilB - utilA;
        return b.inFlight - a.inFlight;
      }
      case 'processed_desc': {
        return b.totalProcessed - a.totalProcessed;
      }
      case 'hostname_asc': {
        return a.hostname.localeCompare(b.hostname);
      }
      default:
        return 0;
    }
  });
}

/**
 * Formats a duration in milliseconds into a concise operational duration string.
 */
export function formatDurationMs(ms: number): string {
  if (ms <= 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0
      ? `${hours}h ${remainingMinutes}m`
      : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

/**
 * Formats worker uptime from startedAt timestamp.
 */
export function formatUptime(
  startedAt: string,
  now: number = Date.now(),
): string {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return 'unknown';
  const diffMs = Math.max(0, now - started);
  return formatDurationMs(diffMs);
}

/**
 * Evaluates remaining lease TTL for an active lease.
 */
export function formatLeaseTimeRemaining(
  leaseExpiresAt: string,
  now: number = Date.now(),
): { expired: boolean; label: string; remainingMs: number } {
  const expires = Date.parse(leaseExpiresAt);
  if (Number.isNaN(expires)) {
    return { expired: false, label: 'unknown', remainingMs: 0 };
  }
  const diffMs = expires - now;
  if (diffMs <= 0) {
    const overdueMs = Math.abs(diffMs);
    return {
      expired: true,
      label: `expired ${formatDurationMs(overdueMs)} ago`,
      remainingMs: diffMs,
    };
  }
  return {
    expired: false,
    label: `${formatDurationMs(diffMs)} left`,
    remainingMs: diffMs,
  };
}
