import { JobCancelDialog } from '@/components/jobs/job-cancel-dialog';
import { QuickEnqueueDialog } from '@/components/jobs/quick-enqueue-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useJobsList, useQueueStats, useWorkers } from '@/hooks/api';
import {
  computePipelineSegments,
  computeQueueOperationalSummary,
  computeSystemHealth,
  filterRecentJobs,
  type QueueOperationalSummary,
  type RecentJobsTab,
} from '@/lib/dashboard-helpers';
import { formatClockUTC, formatDurationMs, formatRelative } from '@/lib/format';
import {
  extractQueueOptions,
  formatAttemptRatio,
  isJobCancellable,
} from '@/lib/jobs-helpers';
import { useLiveConnection } from '@/lib/live/use-live-connection';
import {
  ROUTES,
  jobDetailPath,
  jobsByQueuePath,
  jobsByStatusPath,
  workerDetailPath,
} from '@/lib/routes';
import type { Job, Worker } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  computeFleetMetrics,
  getWorkerLifecycle,
  getWorkerStatusBadgeProps,
} from '@/lib/workers-helpers';
import {
  Activity01Icon,
  Add01Icon,
  Alert02Icon,
  AlertCircleIcon,
  ArrowRight01Icon,
  Cancel01Icon,
  Copy01Icon,
  Refresh01Icon,
  ServerStack01Icon,
  Task01Icon,
  Tick01Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ComponentProps } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

type IconRef = ComponentProps<typeof HugeiconsIcon>['icon'];

export function DashboardPage() {
  const navigate = useNavigate();

  // Primary API queries
  const stats = useQueueStats();
  const workers = useWorkers();
  const recentJobs = useJobsList({ limit: 12, offset: 0 });

  // Live SSE connection status
  const { status: liveStatus, connected: liveConnected } = useLiveConnection();

  // Local interactive UI state
  const [recentTab, setRecentTab] = useState<RecentJobsTab>('all');
  const [cancellingJob, setCancellingJob] = useState<Job | null>(null);
  const [isQuickEnqueueOpen, setIsQuickEnqueueOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date>(
    () => new Date(),
  );

  // Copy helper with 2s active state feedback
  const handleCopyId = useCallback((id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    navigator.clipboard.writeText(id);
    setCopiedId(id);
    setTimeout(() => {
      setCopiedId((curr) => (curr === id ? null : curr));
    }, 2000);
  }, []);

  // Manual refresh trigger
  const handleRefresh = useCallback(async () => {
    setIsManualRefreshing(true);
    try {
      await Promise.all([
        stats.refetch(),
        workers.refetch(),
        recentJobs.refetch(),
      ]);
      setLastRefreshedAt(new Date());
    } finally {
      setIsManualRefreshing(false);
    }
  }, [stats, workers, recentJobs]);

  const isAnyFetching =
    stats.isFetching || workers.isFetching || recentJobs.isFetching;

  // Domain aggregations & metrics
  const totals = stats.data?.totals;
  const waiting = totals ? totals.queued + totals.scheduled : null;

  const fleetMetrics = useMemo(
    () => computeFleetMetrics(workers.data?.workers ?? []),
    [workers.data?.workers],
  );

  const systemHealth = useMemo(
    () =>
      computeSystemHealth({
        isApiError: stats.isError || workers.isError,
        apiErrorMessage: (stats.error ?? workers.error)?.message,
        totals,
        fleetMetrics,
      }),
    [
      stats.isError,
      workers.isError,
      stats.error,
      workers.error,
      totals,
      fleetMetrics,
    ],
  );

  const statsData = stats.data;
  const workersData = workers.data;

  const queueSummaries = useMemo<QueueOperationalSummary[]>(() => {
    if (!statsData?.queues) return [];
    return statsData.queues.map((q) =>
      computeQueueOperationalSummary(q, workersData?.workers ?? []),
    );
  }, [statsData, workersData]);

  const availableQueues = useMemo(
    () => extractQueueOptions(statsData?.queues ?? []),
    [statsData],
  );

  const rawRecentJobs = useMemo(
    () => recentJobs.data?.jobs ?? [],
    [recentJobs.data?.jobs],
  );
  const filteredJobs = useMemo(
    () => filterRecentJobs(rawRecentJobs, recentTab),
    [rawRecentJobs, recentTab],
  );

  const runningRecentCount = useMemo(
    () => rawRecentJobs.filter((j) => j.status === 'running').length,
    [rawRecentJobs],
  );

  const attentionRecentCount = useMemo(
    () =>
      rawRecentJobs.filter(
        (j) => j.status === 'failed' || j.status === 'dead-lettered',
      ).length,
    [rawRecentJobs],
  );

  const pipeline = useMemo(() => computePipelineSegments(totals), [totals]);

  const initialLoading = stats.isLoading && workers.isLoading;

  return (
    <div className="space-y-6">
      {/* ==================================================================== */}
      {/* SCREEN HEADER: High-Density Operational Overview & Live Indicators   */}
      {/* ==================================================================== */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-text-primary text-base font-semibold tracking-tight">
              Operational Command Center
            </h2>
            {/* System Health Pill */}
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[0.6875rem] font-medium',
                systemHealth.level === 'healthy' &&
                  'bg-status-success-bg text-status-success-text border-status-success-border',
                systemHealth.level === 'degraded' &&
                  'bg-status-warning-bg text-status-warning-text border-status-warning-border',
                (systemHealth.level === 'at_risk' ||
                  systemHealth.level === 'error') &&
                  'bg-status-danger-bg text-status-danger-text border-status-danger-border',
              )}
              title={systemHealth.summary}
            >
              <span
                className={cn('size-1.5 rounded-full', systemHealth.dotClass)}
                aria-hidden
              />
              {systemHealth.label}
            </span>
          </div>

          <div className="text-text-muted flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            {/* SSE Stream State */}
            <span className="inline-flex items-center gap-1.5">
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  liveConnected
                    ? 'bg-status-success-solid'
                    : liveStatus === 'connecting'
                      ? 'bg-status-warning-solid'
                      : 'bg-status-neutral-solid',
                )}
                aria-hidden
              />
              {liveConnected
                ? 'Live SSE connected'
                : liveStatus === 'connecting'
                  ? 'Connecting to event stream…'
                  : 'Live updates paused (60s fallback)'}
            </span>
            <span className="text-text-muted/40">·</span>
            <span className="tabular-nums">
              Refreshed {formatClockUTC(lastRefreshedAt.toISOString())} UTC
            </span>
            {isAnyFetching && (
              <>
                <span className="text-text-muted/40">·</span>
                <span className="text-text-muted/70">syncing…</span>
              </>
            )}
          </div>
        </div>

        {/* Operational Actions */}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={isManualRefreshing || isAnyFetching}
            className="gap-1.5"
            title="Force refresh queue stats and worker roster"
          >
            <HugeiconsIcon
              icon={Refresh01Icon}
              className={cn(
                'size-3.5',
                (isManualRefreshing || isAnyFetching) && 'animate-spin',
              )}
            />
            <span className="hidden sm:inline">Refresh</span>
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setIsQuickEnqueueOpen(true)}
            className="gap-1.5"
          >
            <HugeiconsIcon icon={Add01Icon} className="size-3.5" />
            <span>Quick Enqueue</span>
          </Button>

          <Button asChild size="sm">
            <Link to={ROUTES.jobEnqueue}>
              <HugeiconsIcon icon={ArrowRight01Icon} data-icon="inline-start" />
              Guided Enqueue
            </Link>
          </Button>
        </div>
      </div>

      {/* ==================================================================== */}
      {/* SYSTEM ALERTS & DEGRADATION BANNERS                                  */}
      {/* ==================================================================== */}
      {(stats.isError || workers.isError) && (
        <div
          role="alert"
          className="border-status-danger-border bg-status-danger-bg text-status-danger-text flex flex-col gap-2 rounded-md border p-3 text-xs sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-start gap-2">
            <HugeiconsIcon
              icon={AlertCircleIcon}
              className="mt-0.5 size-4 shrink-0"
            />
            <div>
              <p className="font-semibold">API Connection Error</p>
              <p className="opacity-90">
                {stats.error?.message || workers.error?.message} — Ensure the Go
                API server is active on the configured origin.
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            className="bg-surface-base text-text-primary self-start sm:self-auto"
          >
            Retry Connection
          </Button>
        </div>
      )}

      {/* Stale Worker Diagnostic Warning */}
      {!workers.isLoading && fleetMetrics.staleWorkers > 0 && (
        <div
          role="status"
          className="border-status-warning-border bg-status-warning-bg text-status-warning-text flex items-start gap-2.5 rounded-md border p-3 text-xs"
        >
          <HugeiconsIcon
            icon={Alert02Icon}
            className="mt-0.5 size-4 shrink-0"
          />
          <div className="space-y-0.5">
            <p className="font-semibold">
              Fleet Degradation Warning: {fleetMetrics.staleWorkers} Worker
              Heartbeat{fleetMetrics.staleWorkers === 1 ? '' : 's'} Overdue
            </p>
            <p className="opacity-90">
              One or more worker processes have stopped heartbeating past 3×
              their expected interval. Their held leases will be automatically
              reclaimed upon expiration (SPEC §5).
            </p>
          </div>
        </div>
      )}

      {/* Fleet Offline Warning */}
      {!stats.isLoading &&
        !workers.isLoading &&
        fleetMetrics.activeFleetWorkers === 0 &&
        !workers.isError && (
          <div
            role="status"
            className="border-border-subtle bg-surface-elevated/60 text-text-secondary flex items-start gap-2.5 rounded-md border p-3 text-xs"
          >
            <HugeiconsIcon
              icon={ServerStack01Icon}
              className="mt-0.5 size-4 shrink-0"
            />
            <div className="space-y-0.5">
              <p className="text-text-primary font-medium">
                Worker Fleet Offline
              </p>
              <p className="text-text-muted">
                No active workers are online. Enqueued jobs will sit waiting in
                PostgreSQL until a worker process boots and claims work.
              </p>
            </div>
          </div>
        )}

      {/* ==================================================================== */}
      {/* HIGH-SIGNAL SYSTEM & QUEUE HEALTH KPI CARDS                          */}
      {/* ==================================================================== */}
      <section
        aria-label="System KPI metrics"
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
      >
        <MetricCard
          to={jobsByStatusPath('queued', 'scheduled')}
          label="Waiting Backlog"
          value={waiting}
          hint={
            totals
              ? `${totals.queued} queued · ${totals.scheduled} scheduled`
              : 'Queued + scheduled'
          }
          icon={Task01Icon}
          loading={initialLoading}
          tone={waiting && waiting > 200 ? 'warn' : 'default'}
        />

        <MetricCard
          to={jobsByStatusPath('running')}
          label="In-Flight"
          value={totals?.running ?? null}
          hint={
            fleetMetrics.totalCapacity > 0
              ? `${totals?.running ?? 0} of ${fleetMetrics.totalCapacity} fleet slots`
              : 'Active execution leases'
          }
          icon={Activity01Icon}
          loading={initialLoading}
          tone="default"
        />

        <MetricCard
          to={jobsByStatusPath('failed')}
          label="Retrying Soon"
          value={totals?.failed ?? null}
          hint="Transient backoff"
          icon={AlertCircleIcon}
          loading={initialLoading}
          tone={totals && totals.failed > 0 ? 'warn' : 'default'}
        />

        <MetricCard
          to={jobsByStatusPath('dead-lettered')}
          label="Dead-Lettered"
          value={totals?.deadLettered ?? null}
          hint="Exhausted budget"
          icon={Cancel01Icon}
          loading={initialLoading}
          tone={totals && totals.deadLettered > 0 ? 'danger' : 'default'}
        />

        <MetricCard
          to={ROUTES.workers}
          label="Active Fleet"
          value={fleetMetrics.activeFleetWorkers}
          hint={
            fleetMetrics.staleWorkers > 0
              ? `${fleetMetrics.staleWorkers} stale · ${fleetMetrics.utilizationPct}% utilized`
              : fleetMetrics.totalCapacity > 0
                ? `${fleetMetrics.utilizationPct}% utilization (${fleetMetrics.idleWorkers} idle)`
                : '0 capacity'
          }
          icon={ServerStack01Icon}
          loading={workers.isLoading}
          tone={
            fleetMetrics.staleWorkers > 0
              ? 'warn'
              : fleetMetrics.activeFleetWorkers === 0
                ? 'danger'
                : 'default'
          }
        />
      </section>

      {/* ==================================================================== */}
      {/* PIPELINE DISTRIBUTION STRIP                                          */}
      {/* ==================================================================== */}
      {pipeline.totalJobs > 0 && (
        <section
          aria-label="Lifecycle distribution"
          className="border-border-subtle bg-surface-base space-y-2.5 rounded-lg border p-3.5"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-text-primary text-xs font-semibold">
              Execution Lifecycle Pipeline
            </span>
            <span className="text-text-muted inline-flex items-center gap-1.5 font-mono text-[0.6875rem] tabular-nums">
              <HugeiconsIcon icon={Tick02Icon} className="size-3" />
              {pipeline.totalJobs.toLocaleString()} jobs tracked
            </span>
          </div>

          {/* Segmented Bar */}
          <div className="bg-surface-elevated flex h-2.5 overflow-hidden rounded-full">
            {pipeline.segments.map((seg) => (
              <Link
                key={seg.id}
                to={seg.href}
                title={`${seg.label}: ${seg.count.toLocaleString()} (${seg.pct}%)`}
                className={cn(
                  'h-full min-w-[3px] transition-opacity hover:opacity-80',
                  seg.barColorClass,
                )}
                style={{ width: `${seg.pct}%` }}
              />
            ))}
          </div>

          {/* Legend Items */}
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 pt-0.5">
            {pipeline.segments.map((seg) => (
              <Link
                key={seg.id}
                to={seg.href}
                className="text-text-muted hover:text-text-primary flex items-center gap-1.5 text-[0.6875rem] transition-colors"
              >
                <span
                  className={cn('size-1.5 rounded-full', seg.dotColorClass)}
                  aria-hidden
                />
                <span className="text-text-secondary font-medium">
                  {seg.label}
                </span>
                <span className="font-mono tabular-nums">
                  {seg.count.toLocaleString()}
                </span>
                <span className="text-text-muted/60 text-[0.625rem] tabular-nums">
                  ({seg.pct}%)
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* ==================================================================== */}
      {/* 2-COLUMN OPERATIONAL SNAPSHOT: Queues & Worker Fleet                 */}
      {/* ==================================================================== */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* COLUMN A: Queue Depth & Diagnostics */}
        <Card className="border-border-subtle bg-surface-base">
          <CardHeader className="flex-row items-center justify-between pb-2">
            <div className="space-y-0.5">
              <CardTitle className="text-text-primary text-xs font-semibold">
                Queue Backlog & Depth
              </CardTitle>
              <p className="text-text-muted text-[0.6875rem]">
                Partitioned by <code className="font-mono">jobs.queue</code>{' '}
                label
              </p>
            </div>
            <Link
              to={ROUTES.jobs}
              className="text-text-muted hover:text-text-primary text-[0.6875rem] font-medium"
            >
              All jobs →
            </Link>
          </CardHeader>
          <CardContent className="px-0 pb-1">
            {stats.isLoading ? (
              <TableSkeleton columns={7} rows={3} />
            ) : queueSummaries.length === 0 ? (
              <EmptyBlock
                title="No queue activity recorded"
                body="Enqueue a job to initialize a queue and monitor backlog depth here."
                actionHref={ROUTES.jobEnqueue}
                actionLabel="Enqueue First Job"
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-border-subtle">
                    <TableHead className="text-[0.6875rem]">Queue</TableHead>
                    <TableHead className="text-right text-[0.6875rem]">
                      Waiting
                    </TableHead>
                    <TableHead className="text-right text-[0.6875rem]">
                      In-Flight
                    </TableHead>
                    <TableHead className="text-right text-[0.6875rem]">
                      24h OK
                    </TableHead>
                    <TableHead className="text-right text-[0.6875rem]">
                      24h Fail
                    </TableHead>
                    <TableHead className="text-right text-[0.6875rem]">
                      Fleet Coverage
                    </TableHead>
                    <TableHead className="text-right text-[0.6875rem]">
                      Action
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queueSummaries.map((q) => (
                    <TableRow
                      key={q.name}
                      className="hover:bg-surface-elevated/40 border-border-subtle cursor-pointer transition-colors"
                      onClick={() => navigate(jobsByQueuePath(q.name))}
                    >
                      <TableCell className="py-2.5">
                        <div className="space-y-0.5">
                          <span className="text-text-primary font-mono text-[0.6875rem] font-medium">
                            {q.name}
                          </span>
                          {q.health !== 'healthy' && (
                            <div>
                              <Badge
                                tone={
                                  q.statusTone === 'danger'
                                    ? 'danger'
                                    : 'warning'
                                }
                                className="text-[0.625rem]"
                              >
                                {q.statusLabel}
                              </Badge>
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-text-primary text-right font-mono text-[0.6875rem] tabular-nums">
                        {q.depth.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-text-secondary text-right font-mono text-[0.6875rem] tabular-nums">
                        {q.inFlight}
                      </TableCell>
                      <TableCell className="text-text-muted text-right font-mono text-[0.6875rem] tabular-nums">
                        {q.succeeded24h.toLocaleString()}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right font-mono text-[0.6875rem] tabular-nums',
                          q.failed24h + q.deadLettered24h > 0
                            ? 'text-status-danger-text font-medium'
                            : 'text-text-muted',
                        )}
                      >
                        {(q.failed24h + q.deadLettered24h).toLocaleString()}
                        {q.failureRatePct24h > 0 && (
                          <span className="text-text-muted/70 ml-1 text-[0.625rem]">
                            ({q.failureRatePct24h}%)
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <span
                          className={cn(
                            'font-mono text-[0.6875rem] tabular-nums',
                            q.assignedWorkerCount === 0
                              ? 'text-status-danger-text font-medium'
                              : 'text-text-muted',
                          )}
                          title={`${q.assignedWorkerCount} active worker(s) subscribed to queue ${q.name}`}
                        >
                          {q.assignedWorkerCount} worker
                          {q.assignedWorkerCount === 1 ? '' : 's'}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <div
                          className="flex items-center justify-end gap-1.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled
                            title="Queue pause control (POST /queues/:name/pause) pending backend implementation"
                            className="text-text-disabled h-6 cursor-not-allowed px-1.5 text-[0.625rem]"
                            onClick={(e) => {
                              e.stopPropagation();
                              e.preventDefault();
                            }}
                          >
                            Pause
                          </Button>
                          <Button
                            asChild
                            variant="ghost"
                            size="sm"
                            className="text-text-muted hover:text-text-primary h-6 px-2 text-[0.6875rem]"
                            onClick={(e) => {
                              e.stopPropagation();
                            }}
                          >
                            <Link to={jobsByQueuePath(q.name)}>Filter</Link>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* COLUMN B: Worker Fleet & Leases */}
        <Card className="border-border-subtle bg-surface-base">
          <CardHeader className="flex-row items-center justify-between pb-2">
            <div className="space-y-0.5">
              <CardTitle className="text-text-primary text-xs font-semibold">
                Fleet Roster & Utilization
              </CardTitle>
              <p className="text-text-muted text-[0.6875rem]">
                {fleetMetrics.activeFleetWorkers} active ·{' '}
                {fleetMetrics.totalInFlight}/{fleetMetrics.totalCapacity} leased
                ({fleetMetrics.utilizationPct}% utilization)
              </p>
            </div>
            <Link
              to={ROUTES.workers}
              className="text-text-muted hover:text-text-primary text-[0.6875rem] font-medium"
            >
              All workers →
            </Link>
          </CardHeader>
          <CardContent className="px-0 pb-1">
            {workers.isLoading ? (
              <div className="space-y-2 p-4">
                <div className="bg-surface-elevated h-10 animate-pulse rounded-md" />
                <div className="bg-surface-elevated h-10 animate-pulse rounded-md" />
                <div className="bg-surface-elevated h-10 animate-pulse rounded-md" />
              </div>
            ) : !workers.data || workers.data.workers.length === 0 ? (
              <EmptyBlock
                title="No workers online"
                body="Boot the Go worker process so available queue work can be claimed."
              />
            ) : (
              <ul className="divide-border-subtle divide-y">
                {workers.data.workers.slice(0, 6).map((w: Worker) => {
                  const lifecycle = getWorkerLifecycle(w);
                  const badgeProps = getWorkerStatusBadgeProps(lifecycle);

                  return (
                    <li key={w.id}>
                      <Link
                        to={workerDetailPath(w.id)}
                        className="hover:bg-surface-elevated/40 flex items-center justify-between gap-3 px-4 py-2.5 text-xs transition-colors"
                      >
                        <div className="min-w-0 space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span className="text-text-primary truncate font-mono text-[0.6875rem] font-medium">
                              {w.hostname}
                            </span>
                            <span className="text-text-muted/60 font-mono text-[0.625rem]">
                              pid:{w.pid}
                            </span>
                          </div>
                          <div className="text-text-muted truncate text-[0.625rem]">
                            <span>
                              {w.queues.length > 0
                                ? w.queues.join(', ')
                                : 'no queues'}
                            </span>
                            <span className="text-text-muted/50 mx-1">·</span>
                            <span
                              className={cn(
                                lifecycle === 'stale' &&
                                  'text-status-warning-text font-medium',
                              )}
                            >
                              heartbeat {formatRelative(w.lastHeartbeatAt)}
                            </span>
                          </div>
                        </div>

                        <div className="flex shrink-0 items-center gap-2">
                          <span
                            className="text-text-muted font-mono text-[0.6875rem] tabular-nums"
                            title="In flight leases / max concurrency"
                          >
                            {w.inFlight}/{w.maxConcurrency}
                          </span>
                          <Badge tone={badgeProps.tone}>
                            {badgeProps.label}
                          </Badge>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ==================================================================== */}
      {/* RECENT JOBS OPERATIONAL STREAM: Fast Triage & Quick Inspection       */}
      {/* ==================================================================== */}
      <section className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <h3 className="text-text-primary text-sm font-semibold tracking-tight">
              Recent Job Activity
            </h3>
            {/* Triage Filter Tabs */}
            <div className="border-border-subtle bg-surface-elevated/50 flex items-center rounded-md border p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setRecentTab('all')}
                className={cn(
                  'rounded-sm px-2.5 py-0.5 font-medium transition-colors',
                  recentTab === 'all'
                    ? 'bg-surface-base text-text-primary shadow-xs'
                    : 'text-text-muted hover:text-text-primary',
                )}
              >
                All ({rawRecentJobs.length})
              </button>
              <button
                type="button"
                onClick={() => setRecentTab('running')}
                className={cn(
                  'rounded-sm px-2.5 py-0.5 font-medium transition-colors',
                  recentTab === 'running'
                    ? 'bg-surface-base text-text-primary shadow-xs'
                    : 'text-text-muted hover:text-text-primary',
                )}
              >
                In-Flight ({runningRecentCount})
              </button>
              <button
                type="button"
                onClick={() => setRecentTab('attention')}
                className={cn(
                  'rounded-sm px-2.5 py-0.5 font-medium transition-colors',
                  recentTab === 'attention'
                    ? 'bg-surface-base text-text-primary shadow-xs'
                    : 'text-text-muted hover:text-text-primary',
                  attentionRecentCount > 0 && 'text-status-danger-text',
                )}
              >
                Failed / DLQ ({attentionRecentCount})
              </button>
            </div>
          </div>

          <Link
            to={ROUTES.jobs}
            className="text-text-muted hover:text-text-primary text-[0.6875rem] font-medium"
          >
            Open full jobs catalog →
          </Link>
        </div>

        <div className="border-border-subtle bg-surface-base overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="border-border-subtle">
                <TableHead className="text-[0.6875rem]">Job ID</TableHead>
                <TableHead className="text-[0.6875rem]">Handler</TableHead>
                <TableHead className="text-[0.6875rem]">Queue</TableHead>
                <TableHead className="text-[0.6875rem]">Status</TableHead>
                <TableHead className="text-[0.6875rem]">Enqueued</TableHead>
                <TableHead className="text-right text-[0.6875rem]">
                  Duration
                </TableHead>
                <TableHead className="text-right text-[0.6875rem]">
                  Action
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentJobs.isLoading ? (
                <TableSkeleton columns={7} rows={4} />
              ) : filteredJobs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8">
                    <EmptyBlock
                      title={
                        recentTab === 'running'
                          ? 'No jobs in flight'
                          : recentTab === 'attention'
                            ? 'No failed or dead-lettered jobs'
                            : 'No recent jobs recorded'
                      }
                      body={
                        recentTab === 'running'
                          ? 'Workers are currently idle or finished with active leases.'
                          : recentTab === 'attention'
                            ? 'All recent job executions succeeded or are nominal.'
                            : 'Dispatch an execution payload to monitor live progress.'
                      }
                      actionHref={
                        recentTab === 'all' ? ROUTES.jobEnqueue : undefined
                      }
                      actionLabel={
                        recentTab === 'all' ? 'Enqueue Job' : undefined
                      }
                    />
                  </TableCell>
                </TableRow>
              ) : (
                filteredJobs.map((j) => {
                  const lastAttempt = j.attempts[j.attempts.length - 1];
                  const cancellable = isJobCancellable(j.status);
                  const isCopied = copiedId === j.id;

                  return (
                    <TableRow
                      key={j.id}
                      className="hover:bg-surface-elevated/40 border-border-subtle cursor-pointer transition-colors"
                      onClick={() => navigate(jobDetailPath(j.id))}
                    >
                      {/* Job ID + Copy */}
                      <TableCell className="py-2.5">
                        <div className="flex items-center gap-1.5">
                          <span
                            className="text-text-primary font-mono text-[0.6875rem]"
                            title={j.id}
                          >
                            …{j.id.slice(-10)}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              e.preventDefault();
                              handleCopyId(j.id, e);
                            }}
                            className="text-text-muted hover:text-text-primary rounded-sm p-0.5 transition-colors"
                            title="Copy full Job ULID"
                          >
                            <HugeiconsIcon
                              icon={isCopied ? Tick01Icon : Copy01Icon}
                              className={cn(
                                'size-3',
                                isCopied && 'text-status-success-text',
                              )}
                            />
                          </button>
                        </div>
                      </TableCell>

                      {/* Handler */}
                      <TableCell className="text-text-primary font-mono text-[0.6875rem]">
                        {j.handler}
                      </TableCell>

                      {/* Queue */}
                      <TableCell className="text-text-muted font-mono text-[0.6875rem]">
                        {j.queue}
                      </TableCell>

                      {/* Status Badge */}
                      <TableCell>
                        <StatusBadge status={j.status} />
                      </TableCell>

                      {/* Enqueued Timestamp */}
                      <TableCell className="text-text-muted font-mono text-[0.6875rem] tabular-nums">
                        <span>{formatClockUTC(j.enqueuedAt)}</span>
                        <span className="text-text-muted/60 ml-1 text-[0.625rem]">
                          ({formatRelative(j.enqueuedAt)})
                        </span>
                      </TableCell>

                      {/* Duration / Attempts */}
                      <TableCell className="text-text-secondary text-right font-mono text-[0.6875rem] tabular-nums">
                        {lastAttempt?.durationMs != null ? (
                          formatDurationMs(lastAttempt.durationMs)
                        ) : (
                          <span className="text-text-muted">—</span>
                        )}
                        <span className="text-text-muted/60 ml-1 text-[0.625rem]">
                          (att {formatAttemptRatio(j.attempt, j.maxAttempts)})
                        </span>
                      </TableCell>

                      {/* Actions */}
                      <TableCell className="text-right">
                        <div
                          className="flex items-center justify-end gap-1.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {cancellable ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="text-status-danger-text hover:bg-status-danger-bg hover:text-status-danger-text h-6 px-2 text-[0.6875rem]"
                              onClick={(e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                setCancellingJob(j);
                              }}
                              title="Cancel job (SPEC §6)"
                            >
                              Cancel
                            </Button>
                          ) : (
                            <Button
                              asChild
                              variant="ghost"
                              size="sm"
                              className="text-text-muted hover:text-text-primary h-6 px-2 text-[0.6875rem]"
                              onClick={(e) => {
                                e.stopPropagation();
                              }}
                            >
                              <Link to={jobDetailPath(j.id)}>View</Link>
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      {/* ==================================================================== */}
      {/* MODALS & DRAWERS: Quick Enqueue & Cancellation                       */}
      {/* ==================================================================== */}
      <QuickEnqueueDialog
        open={isQuickEnqueueOpen}
        onOpenChange={setIsQuickEnqueueOpen}
        availableQueues={availableQueues}
        onSuccess={() => {
          handleRefresh();
        }}
      />

      <JobCancelDialog
        job={cancellingJob}
        open={Boolean(cancellingJob)}
        onOpenChange={(open) => {
          if (!open) setCancellingJob(null);
        }}
        onSuccess={() => {
          handleRefresh();
        }}
      />
    </div>
  );
}

/* ========================================================================== */
/* HELPER COMPONENTS: MetricCard, TableSkeleton, EmptyBlock                   */
/* ========================================================================== */

function MetricCard({
  to,
  label,
  value,
  hint,
  icon,
  loading,
  tone = 'default',
}: {
  to: string;
  label: string;
  value: number | null;
  hint: string;
  icon: IconRef;
  loading: boolean;
  tone?: 'default' | 'warn' | 'danger';
}) {
  const isHot =
    (tone === 'danger' || tone === 'warn') && value != null && value > 0;

  return (
    <Link
      to={to}
      className={cn(
        'group bg-surface-base hover:bg-surface-elevated/60 border-border-subtle focus-visible:ring-ring/50 block rounded-lg border p-3.5 outline-hidden transition-colors focus-visible:ring-2',
        isHot &&
          tone === 'danger' &&
          'border-status-danger-border bg-status-danger-bg/20',
        isHot &&
          tone === 'warn' &&
          'border-status-warning-border bg-status-warning-bg/20',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-text-muted text-[0.6875rem] font-medium tracking-wide uppercase">
          {label}
        </div>
        <HugeiconsIcon
          icon={icon}
          className={cn(
            'text-text-muted group-hover:text-text-primary size-4 transition-colors',
            isHot && tone === 'danger' && 'text-status-danger-text',
            isHot && tone === 'warn' && 'text-status-warning-text',
          )}
        />
      </div>

      <div
        className={cn(
          'text-text-primary mt-1.5 font-mono text-2xl font-semibold tracking-tight tabular-nums',
          isHot && tone === 'danger' && 'text-status-danger-text',
          isHot && tone === 'warn' && 'text-status-warning-text',
        )}
      >
        {loading ? (
          <span className="text-text-muted text-base">…</span>
        ) : value === null ? (
          <span className="text-text-muted">—</span>
        ) : (
          value.toLocaleString()
        )}
      </div>

      <div className="text-text-muted mt-1 truncate font-mono text-[0.625rem]">
        {hint}
      </div>
    </Link>
  );
}

function TableSkeleton({ columns, rows }: { columns: number; rows: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, rIdx) => (
        <TableRow key={rIdx} className="border-border-subtle">
          {Array.from({ length: columns }).map((_, cIdx) => (
            <TableCell key={cIdx} className="py-3">
              <div
                className={cn(
                  'bg-surface-elevated h-3.5 animate-pulse rounded',
                  cIdx === 0 ? 'w-24' : 'ml-auto w-16',
                )}
              />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

function EmptyBlock({
  title,
  body,
  actionHref,
  actionLabel,
}: {
  title: string;
  body: string;
  actionHref?: string;
  actionLabel?: string;
}) {
  return (
    <div className="flex flex-col items-start gap-2 px-4 py-6">
      <p className="text-text-primary text-xs font-semibold">{title}</p>
      <p className="text-text-muted max-w-sm text-xs leading-relaxed">{body}</p>
      {actionHref && actionLabel && (
        <Button asChild size="sm" variant="outline" className="mt-1">
          <Link to={actionHref}>{actionLabel}</Link>
        </Button>
      )}
    </div>
  );
}
