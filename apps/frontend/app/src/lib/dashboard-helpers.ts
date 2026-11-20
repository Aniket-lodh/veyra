import type { QueueAggregate, StatusTotals } from './api/stats.ts';
import { jobsByQueuePath, jobsByStatusPath, ROUTES } from './routes.ts';
import type { Job, Worker } from './types.ts';
import type { FleetMetrics } from './workers-helpers.ts';

export type SystemHealthLevel = 'healthy' | 'degraded' | 'at_risk' | 'error';

export interface OperationalAlertItem {
  id: string;
  severity: 'critical' | 'warning';
  title: string;
  message: string;
  actionLabel: string;
  actionHref: string;
  secondaryAction?: {
    label: string;
    actionKey: 'replay-dlq';
  };
  disabledSecondaryAction?: {
    label: string;
    pendingReason: string;
  };
}

export interface SystemHealthInfo {
  level: SystemHealthLevel;
  label: string;
  dotClass: string;
  badgeTone: 'success' | 'warning' | 'danger' | 'muted';
  summary: string;
  criticalIssues: string[];
  warnings: string[];
  alerts: OperationalAlertItem[];
}

/**
 * Computes high-signal system operational health status from API errors,
 * queue totals, fleet capacity/stale metrics, and per-queue worker coverage.
 */
export function computeSystemHealth(params: {
  isApiError: boolean;
  apiErrorMessage?: string;
  totals?: StatusTotals;
  fleetMetrics?: FleetMetrics;
  queueSummaries?: QueueOperationalSummary[];
}): SystemHealthInfo {
  const { isApiError, apiErrorMessage, totals, fleetMetrics, queueSummaries } =
    params;

  if (isApiError) {
    const errorAlert: OperationalAlertItem = {
      id: 'api-error',
      severity: 'critical',
      title: 'API Server Unreachable',
      message: apiErrorMessage
        ? `API error: ${apiErrorMessage}`
        : 'Cannot communicate with the Veyra API server. Verify the service is online.',
      actionLabel: 'Retry Connection',
      actionHref: ROUTES.dashboard,
    };

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
      alerts: [errorAlert],
    };
  }

  const criticalIssues: string[] = [];
  const warnings: string[] = [];
  const alerts: OperationalAlertItem[] = [];

  const waiting = (totals?.queued ?? 0) + (totals?.scheduled ?? 0);
  const deadLettered = totals?.deadLettered ?? 0;
  const failed = totals?.failed ?? 0;
  const activeWorkers = fleetMetrics?.activeFleetWorkers ?? 0;
  const staleWorkers = fleetMetrics?.staleWorkers ?? 0;

  // Evaluation 1: No workers online while jobs are waiting
  if (activeWorkers === 0) {
    if (waiting > 0) {
      const msg = `Fleet offline: ${waiting.toLocaleString()} waiting job(s) cannot be claimed.`;
      criticalIssues.push(msg);
      alerts.push({
        id: 'fleet-offline-waiting',
        severity: 'critical',
        title: 'Worker Fleet Offline',
        message: `${waiting.toLocaleString()} waiting job(s) cannot be claimed because 0 active workers are online.`,
        actionLabel: 'Inspect Workers',
        actionHref: ROUTES.workers,
      });
    } else {
      warnings.push('No active workers registered in the fleet.');
      alerts.push({
        id: 'fleet-empty',
        severity: 'warning',
        title: 'No Active Workers Registered',
        message:
          '0 workers are currently registered. Enqueued jobs will wait in PostgreSQL until a worker process boots.',
        actionLabel: 'Fleet Roster',
        actionHref: ROUTES.workers,
      });
    }
  }

  // Evaluation 2: Dead-lettered jobs needing manual intervention
  if (deadLettered > 0) {
    const msg = `${deadLettered.toLocaleString()} dead-lettered job(s) reached max attempt budget.`;
    criticalIssues.push(msg);
    alerts.push({
      id: 'dead-lettered',
      severity: 'critical',
      title: 'Dead-Lettered Jobs Require Attention',
      message: `${deadLettered.toLocaleString()} job(s) exhausted their retry budget and were moved to DLQ (SPEC §7).`,
      actionLabel: 'Review DLQ Jobs',
      actionHref: jobsByStatusPath('dead-lettered'),
      secondaryAction: {
        label: 'Replay DLQ',
        actionKey: 'replay-dlq',
      },
    });
  }

  // Evaluation 3: Unserviced queues with pending backlog and zero active workers
  if (queueSummaries) {
    for (const q of queueSummaries) {
      if (q.assignedWorkerCount === 0 && q.depth > 0) {
        const msg = `Queue '${q.name}' has ${q.depth.toLocaleString()} waiting job(s) with 0 active workers.`;
        criticalIssues.push(msg);
        alerts.push({
          id: `unserviced-queue-${q.name}`,
          severity: 'critical',
          title: `Queue '${q.name}' Has No Active Workers`,
          message: `${q.depth.toLocaleString()} job(s) waiting in queue '${q.name}', but no online workers are subscribed to process it.`,
          actionLabel: `View '${q.name}' Jobs`,
          actionHref: jobsByQueuePath(q.name),
        });
      }
    }
  }

  // Evaluation 4: Stale worker heartbeats past 3× interval
  if (staleWorkers > 0) {
    const msg = `${staleWorkers.toLocaleString()} worker(s) have overdue heartbeats (>3× interval).`;
    warnings.push(msg);
    alerts.push({
      id: 'stale-workers',
      severity: 'warning',
      title: 'Fleet Degradation: Worker Heartbeat Overdue',
      message: `${staleWorkers.toLocaleString()} worker(s) stopped heartbeating past 3× interval. Held leases will be reclaimed upon expiration (SPEC §5).`,
      actionLabel: 'Inspect Fleet',
      actionHref: ROUTES.workers,
    });
  }

  // Evaluation 5: Failing jobs undergoing retry backoff
  if (failed > 0) {
    const msg = `${failed.toLocaleString()} job(s) currently failing and awaiting scheduled retry.`;
    warnings.push(msg);
    alerts.push({
      id: 'failing-jobs',
      severity: 'warning',
      title: 'Transient Failures In Backoff',
      message: `${failed.toLocaleString()} job(s) recently failed and are awaiting scheduled retry.`,
      actionLabel: 'View Failing Jobs',
      actionHref: jobsByStatusPath('failed'),
    });
  }

  // Evaluation 6: High queue failure rates (>= 20% over 24h with at least 5 jobs)
  if (queueSummaries) {
    for (const q of queueSummaries) {
      if (q.failureRatePct24h >= 20 && q.total24h >= 5) {
        alerts.push({
          id: `high-fail-rate-${q.name}`,
          severity: 'warning',
          title: `Elevated Failure Rate on '${q.name}' (${q.failureRatePct24h}%)`,
          message: `${(q.failed24h + q.deadLettered24h).toLocaleString()} of ${q.total24h.toLocaleString()} jobs failed in the last 24h.`,
          actionLabel: `Filter '${q.name}'`,
          actionHref: jobsByQueuePath(q.name),
        });
      }
    }
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
      alerts,
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
      alerts,
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
    alerts: [],
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
