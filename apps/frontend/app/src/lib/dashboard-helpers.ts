import type { QueueAggregate, StatusTotals } from './api/stats.ts';
import { jobsByStatusPath } from './routes.ts';
import type { Job, Worker } from './types.ts';
import type { FleetMetrics } from './workers-helpers.ts';

export type SystemHealthLevel = 'healthy' | 'degraded' | 'at_risk' | 'error';

export interface SystemHealthInfo {
  level: SystemHealthLevel;
  label: string;
  dotClass: string;
  badgeTone: 'success' | 'warning' | 'danger' | 'muted';
  summary: string;
  criticalIssues: string[];
  warnings: string[];
}

/**
 * Computes high-signal system operational health status from API errors,
 * queue totals, and fleet capacity/stale worker metrics.
 */
export function computeSystemHealth(params: {
  isApiError: boolean;
  apiErrorMessage?: string;
  totals?: StatusTotals;
  fleetMetrics?: FleetMetrics;
}): SystemHealthInfo {
  const { isApiError, apiErrorMessage, totals, fleetMetrics } = params;

  if (isApiError) {
    return {
      level: 'error',
      label: 'API Unreachable',
      dotClass: 'bg-status-danger-solid',
      badgeTone: 'danger',
      summary: apiErrorMessage
        ? `API error: ${apiErrorMessage}`
        : 'Cannot communicate with the Veyra API server. Verify the service is online.',
      criticalIssues: ['API server connection failed'],
      warnings: [],
    };
  }

  const criticalIssues: string[] = [];
  const warnings: string[] = [];

  const waiting = (totals?.queued ?? 0) + (totals?.scheduled ?? 0);
  const deadLettered = totals?.deadLettered ?? 0;
  const failed = totals?.failed ?? 0;
  const activeWorkers = fleetMetrics?.activeFleetWorkers ?? 0;
  const staleWorkers = fleetMetrics?.staleWorkers ?? 0;

  // Evaluation 1: No workers online while jobs are waiting
  if (activeWorkers === 0) {
    if (waiting > 0) {
      criticalIssues.push(
        `Fleet offline: ${waiting.toLocaleString()} waiting job(s) cannot be claimed.`,
      );
    } else {
      warnings.push('No active workers registered in the fleet.');
    }
  }

  // Evaluation 2: Dead-lettered jobs needing manual intervention
  if (deadLettered > 0) {
    criticalIssues.push(
      `${deadLettered.toLocaleString()} dead-lettered job(s) reached max attempt budget.`,
    );
  }

  // Evaluation 3: Stale worker heartbeats
  if (staleWorkers > 0) {
    warnings.push(
      `${staleWorkers.toLocaleString()} worker(s) have overdue heartbeats (>3× interval).`,
    );
  }

  // Evaluation 4: Failing jobs undergoing retry
  if (failed > 0) {
    warnings.push(
      `${failed.toLocaleString()} job(s) currently failing and awaiting scheduled retry.`,
    );
  }

  // Determine aggregate operational health level
  if (criticalIssues.length > 0) {
    return {
      level: 'at_risk',
      label: 'At Risk',
      dotClass: 'bg-status-danger-solid',
      badgeTone: 'danger',
      summary: criticalIssues[0],
      criticalIssues,
      warnings,
    };
  }

  if (warnings.length > 0) {
    return {
      level: 'degraded',
      label: 'Degraded',
      dotClass: 'bg-status-warning-solid',
      badgeTone: 'warning',
      summary: warnings[0],
      criticalIssues,
      warnings,
    };
  }

  return {
    level: 'healthy',
    label: 'Healthy',
    dotClass: 'bg-status-success-solid',
    badgeTone: 'success',
    summary:
      'All operational systems healthy. Worker fleet active and queue depth nominal.',
    criticalIssues: [],
    warnings: [],
  };
}

export interface QueueOperationalSummary {
  name: string;
  depth: number;
  inFlight: number;
  succeeded24h: number;
  failed24h: number;
  deadLettered24h: number;
  total24h: number;
  failureRatePct24h: number;
  assignedWorkerCount: number;
  health: 'healthy' | 'warning' | 'critical';
  statusLabel: string;
  statusTone: 'success' | 'warning' | 'danger' | 'neutral';
}

/**
 * Computes queue-level health, 24h error rate percentage, and worker subscription coverage.
 */
export function computeQueueOperationalSummary(
  queue: QueueAggregate,
  workers: Worker[] = [],
): QueueOperationalSummary {
  const succeeded24h = Math.max(0, queue.succeeded24h ?? 0);
  const failed24h = Math.max(0, queue.failed24h ?? 0);
  const deadLettered24h = Math.max(0, queue.deadLettered24h ?? 0);
  const total24h = succeeded24h + failed24h + deadLettered24h;
  const failureCount24h = failed24h + deadLettered24h;

  // Zero-denominator guard: guaranteed safe finite percentage
  const rawRate = total24h > 0 ? (failureCount24h / total24h) * 100 : 0;
  const failureRatePct24h = Number.isFinite(rawRate)
    ? Math.min(100, Math.max(0, Math.round(rawRate * 10) / 10))
    : 0;

  // Active workers (excluding disconnected) subscribed to this queue
  const assignedWorkerCount = workers.filter(
    (w) => w.state !== 'disconnected' && w.queues.includes(queue.name),
  ).length;

  let health: 'healthy' | 'warning' | 'critical' = 'healthy';
  let statusLabel = 'Healthy';
  let statusTone: 'success' | 'warning' | 'danger' | 'neutral' = 'success';

  if (assignedWorkerCount === 0 && queue.depth > 0) {
    health = 'critical';
    statusLabel = 'Unserviced Backlog';
    statusTone = 'danger';
  } else if (failureRatePct24h >= 20 && total24h >= 5) {
    health = 'critical';
    statusLabel = `${failureRatePct24h}% Failed (24h)`;
    statusTone = 'danger';
  } else if (failureRatePct24h >= 5 && total24h >= 5) {
    health = 'warning';
    statusLabel = `${failureRatePct24h}% Failed (24h)`;
    statusTone = 'warning';
  } else if (assignedWorkerCount === 0) {
    health = 'warning';
    statusLabel = 'No Assigned Workers';
    statusTone = 'warning';
  } else if (queue.depth > 200) {
    health = 'warning';
    statusLabel = 'High Depth';
    statusTone = 'warning';
  }

  return {
    name: queue.name,
    depth: queue.depth,
    inFlight: queue.inFlight,
    succeeded24h: queue.succeeded24h,
    failed24h: queue.failed24h,
    deadLettered24h: queue.deadLettered24h,
    total24h,
    failureRatePct24h,
    assignedWorkerCount,
    health,
    statusLabel,
    statusTone,
  };
}

export type RecentJobsTab = 'all' | 'running' | 'attention';

/**
 * Filters recent jobs list according to operator triage tab.
 */
export function filterRecentJobs(jobs: Job[], tab: RecentJobsTab): Job[] {
  switch (tab) {
    case 'running':
      return jobs.filter((j) => j.status === 'running');
    case 'attention':
      return jobs.filter(
        (j) => j.status === 'failed' || j.status === 'dead-lettered',
      );
    case 'all':
    default:
      return jobs;
  }
}

export interface PipelineSegment {
  id: string;
  label: string;
  count: number;
  pct: number;
  href: string;
  barColorClass: string;
  dotColorClass: string;
}

/**
 * Computes pipeline breakdown segments with exact percentage math and deep links.
 */
export function computePipelineSegments(totals?: StatusTotals): {
  segments: PipelineSegment[];
  totalJobs: number;
} {
  if (!totals) {
    return { segments: [], totalJobs: 0 };
  }

  const waiting = totals.queued + totals.scheduled;
  const totalJobs =
    totals.queued +
    totals.scheduled +
    totals.running +
    totals.succeeded +
    totals.failed +
    totals.deadLettered +
    totals.cancelled;

  if (totalJobs === 0) {
    return { segments: [], totalJobs: 0 };
  }

  const rawSegments = [
    {
      id: 'waiting',
      label: 'Waiting',
      count: waiting,
      href: jobsByStatusPath('queued', 'scheduled'),
      barColorClass: 'bg-status-scheduled-solid',
      dotColorClass: 'bg-status-scheduled-solid',
    },
    {
      id: 'running',
      label: 'Running',
      count: totals.running,
      href: jobsByStatusPath('running'),
      barColorClass: 'bg-status-info-solid',
      dotColorClass: 'bg-status-info-solid',
    },
    {
      id: 'succeeded',
      label: 'Succeeded',
      count: totals.succeeded,
      href: jobsByStatusPath('succeeded'),
      barColorClass: 'bg-status-success-solid',
      dotColorClass: 'bg-status-success-solid',
    },
    {
      id: 'failed',
      label: 'Failed',
      count: totals.failed,
      href: jobsByStatusPath('failed'),
      barColorClass: 'bg-status-danger-solid',
      dotColorClass: 'bg-status-danger-solid',
    },
    {
      id: 'dead-lettered',
      label: 'DLQ',
      count: totals.deadLettered,
      href: jobsByStatusPath('dead-lettered'),
      barColorClass: 'bg-status-warning-solid',
      dotColorClass: 'bg-status-warning-solid',
    },
    {
      id: 'cancelled',
      label: 'Cancelled',
      count: totals.cancelled,
      href: jobsByStatusPath('cancelled'),
      barColorClass: 'bg-status-neutral-solid',
      dotColorClass: 'bg-status-neutral-solid',
    },
  ];

  const segments: PipelineSegment[] = rawSegments
    .filter((s) => s.count > 0)
    .map((s) => {
      const rawPct = totalJobs > 0 ? (s.count / totalJobs) * 100 : 0;
      const pct = Number.isFinite(rawPct)
        ? Math.min(100, Math.max(0, Math.round(rawPct * 10) / 10))
        : 0;
      return {
        ...s,
        pct,
      };
    });

  return { segments, totalJobs };
}
