import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useWorker, useReleaseWorkerLease } from '@/hooks/api';
import { ApiError } from '@/lib/api/client';
import { formatDateTimeUTC, formatRelative } from '@/lib/format';
import {
  ROUTES,
  jobDetailPath,
  jobsByHandlerPath,
  jobsByQueuePath,
  jobsByWorkerPath,
} from '@/lib/routes';
import type { WorkerLease } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  formatDurationMs,
  formatLeaseTimeRemaining,
  formatUptime,
  getHeartbeatOverdueDurationMs,
  getWorkerLifecycle,
  getWorkerStatusBadgeProps,
  isHeartbeatStale,
} from '@/lib/workers-helpers';
import {
  Activity01Icon,
  Alert02Icon,
  ArrowLeft01Icon,
  Copy01Icon,
  MoreHorizontalIcon,
  Refresh01Icon,
  Task01Icon,
  Tick01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useCallback, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

export function WorkerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const {
    data: worker,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useWorker(id);

  // Copy feedback state
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Lease force-release mutation & dialog target state
  const [releaseTargetLease, setReleaseTargetLease] =
    useState<WorkerLease | null>(null);
  const releaseLeaseMutation = useReleaseWorkerLease({
    onSuccess: () => {
      setReleaseTargetLease(null);
    },
  });

  const handleConfirmRelease = () => {
    if (!worker || !releaseTargetLease) return;
    releaseLeaseMutation.mutate({
      workerId: worker.id,
      jobId: releaseTargetLease.jobId,
    });
  };

  const handleCopy = useCallback((text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((curr) => (curr === key ? null : curr));
    }, 2000);
  }, []);

  // Worker Not Found State (either missing ID param or explicit 404 from backend)
  const isNotFound =
    !id || (isError && error instanceof ApiError && error.status === 404);
  if (isNotFound) {
    return (
      <div className="space-y-4">
        <Breadcrumb id={id} hostname={undefined} />
        <Card className="border-border-subtle bg-surface-base p-8 text-center">
          <div className="mx-auto max-w-sm space-y-3">
            <h3 className="text-text-primary text-sm font-semibold">
              Worker Not Found
            </h3>
            <p className="text-text-muted text-xs">
              No worker with ID <code className="font-mono">{id ?? '—'}</code>{' '}
              is currently registered in the fleet. The node may have been
              reaped or disconnected.
            </p>
            <Button
              asChild
              variant="outline"
              size="sm"
              className="mt-2 text-xs"
            >
              <Link to={ROUTES.workers}>
                <HugeiconsIcon
                  icon={ArrowLeft01Icon}
                  className="mr-1.5 h-3.5 w-3.5"
                />
                Back to Fleet Roster
              </Link>
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  // Error State
  if (isError) {
    return (
      <div className="space-y-4">
        <Breadcrumb id={id} hostname={undefined} />
        <div
          role="alert"
          className="border-status-danger-border bg-status-danger-bg text-status-danger-text flex items-center justify-between rounded-md border p-3 text-xs"
        >
          <div className="flex items-center gap-2">
            <HugeiconsIcon icon={Alert02Icon} className="h-4 w-4 shrink-0" />
            <span>
              Failed to load worker details:{' '}
              {error?.message ?? 'Unknown server error'}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refetch()}
            className="h-7 text-xs"
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  // Loading State (Only if initial load has no cached data)
  if (isLoading || !worker) {
    return (
      <div className="space-y-4">
        <Breadcrumb id={id} hostname={undefined} />
        <div className="space-y-4">
          <div className="bg-surface-elevated h-6 w-48 animate-pulse rounded" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="bg-surface-base border-border-subtle h-20 animate-pulse rounded-md border p-3"
              />
            ))}
          </div>
          <div className="bg-surface-base border-border-subtle h-48 animate-pulse rounded-md border" />
        </div>
      </div>
    );
  }

  // Shared lifecycle & status calculation from workers-helpers.ts
  const lifecycle = getWorkerLifecycle(worker);
  const badgeProps = getWorkerStatusBadgeProps(lifecycle);
  const isStale = isHeartbeatStale(
    worker.lastHeartbeatAt,
    worker.heartbeatIntervalSeconds,
  );
  const overdueMs = getHeartbeatOverdueDurationMs(
    worker.lastHeartbeatAt,
    worker.heartbeatIntervalSeconds,
  );
  const utilPct =
    worker.maxConcurrency > 0
      ? Math.min(
          100,
          Math.round((worker.inFlight / worker.maxConcurrency) * 100),
        )
      : 0;

  return (
    <div className="space-y-6">
      {/* Navigation Breadcrumb */}
      <Breadcrumb id={worker.id} hostname={worker.hostname} />

      {/* Primary Worker Identity Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-text-primary font-mono text-base font-semibold tracking-tight">
              {worker.hostname}
            </h2>
            {/* Calm status badge with steady semantic dot */}
            <Badge tone={badgeProps.tone}>
              <span
                className={cn(
                  'mr-1.5 inline-block h-1.5 w-1.5 rounded-full',
                  badgeProps.dotColorClass,
                )}
              />
              {badgeProps.label}
            </Badge>
            {isStale && worker.state !== 'disconnected' && (
              <span
                className="text-status-warning-text bg-status-warning-bg border-status-warning-border rounded border px-1.5 py-0.5 text-[0.625rem] font-medium"
                title="Heartbeat older than 3× interval — runtime may have died without deregistering."
              >
                overdue by {formatDurationMs(overdueMs)}
              </span>
            )}
          </div>

          <div className="text-text-muted flex flex-wrap items-center gap-2 font-mono text-xs">
            <span className="flex items-center gap-1">
              <span className="text-text-secondary">ULID:</span>
              <span className="text-text-primary font-medium">{worker.id}</span>
              <button
                type="button"
                onClick={() => handleCopy(worker.id, 'worker-id')}
                className="text-text-muted hover:text-text-primary p-0.5 transition-colors"
                title="Copy Worker ULID"
                aria-label="Copy Worker ULID"
              >
                <HugeiconsIcon
                  icon={copiedKey === 'worker-id' ? Tick01Icon : Copy01Icon}
                  className={cn(
                    'h-3.5 w-3.5',
                    copiedKey === 'worker-id' && 'text-status-success-text',
                  )}
                />
              </button>
            </span>
            <span>·</span>
            <span>PID {worker.pid}</span>
            <span>·</span>
            <span>{worker.version}</span>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              handleCopy(JSON.stringify(worker, null, 2), 'worker-json')
            }
            className="text-xs"
            title="Export structured JSON diagnostics"
          >
            <HugeiconsIcon
              icon={copiedKey === 'worker-json' ? Tick01Icon : Copy01Icon}
              className="mr-1.5 h-3.5 w-3.5"
            />
            {copiedKey === 'worker-json' ? 'Copied Diagnostics' : 'Export JSON'}
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            className="text-xs"
            title="Force refresh worker details"
          >
            <HugeiconsIcon
              icon={Refresh01Icon}
              className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')}
            />
            Refresh
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(jobsByWorkerPath(worker.id))}
            className="text-xs"
            title="View jobs associated with this worker"
          >
            <HugeiconsIcon icon={Task01Icon} className="mr-1.5 h-3.5 w-3.5" />
            View Jobs
          </Button>

          {/* Operational Dropdown Menu (Gated controls disabled with pending-backend badges) */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 p-0"
                aria-label="Worker fleet operations"
              >
                <HugeiconsIcon
                  icon={MoreHorizontalIcon}
                  className="h-3.5 w-3.5"
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="text-text-muted text-[0.625rem] font-medium tracking-wider uppercase">
                Fleet Operations (Pending API)
              </DropdownMenuLabel>

              <DropdownMenuItem
                disabled
                title="Backend capability pending: POST /workers/:id/drain"
                className="text-text-disabled cursor-not-allowed justify-between"
              >
                <span>Drain Worker</span>
                <span className="border-border-subtle bg-surface-elevated text-text-muted rounded px-1 py-0.5 text-[0.5625rem]">
                  API Pending
                </span>
              </DropdownMenuItem>

              <DropdownMenuItem
                disabled
                title="Backend capability pending: PATCH /workers/:id/cordon"
                className="text-text-disabled cursor-not-allowed justify-between"
              >
                <span>Cordon / Pause</span>
                <span className="border-border-subtle bg-surface-elevated text-text-muted rounded px-1 py-0.5 text-[0.5625rem]">
                  API Pending
                </span>
              </DropdownMenuItem>

              {worker.leases.length === 0 ? (
                <DropdownMenuItem
                  disabled
                  title="No active leases held by this worker"
                  className="text-text-disabled cursor-not-allowed justify-between"
                >
                  <span>Force Release Leases</span>
                  <span className="border-border-subtle bg-surface-elevated text-text-muted rounded px-1 py-0.5 text-[0.5625rem]">
                    0 Leases
                  </span>
                </DropdownMenuItem>
              ) : worker.leases.length === 1 ? (
                <DropdownMenuItem
                  onClick={() => setReleaseTargetLease(worker.leases[0])}
                  className="text-status-warning-text hover:text-status-warning-text justify-between"
                >
                  <span>Force Release Lease</span>
                  <span className="border-border-subtle bg-surface-elevated text-text-muted rounded px-1 py-0.5 text-[0.5625rem]">
                    1 Active
                  </span>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  onClick={() => {
                    const el = document.getElementById('active-leases-section');
                    el?.scrollIntoView({ behavior: 'smooth' });
                  }}
                  className="text-text-primary justify-between"
                >
                  <span>Release Leases ({worker.leases.length})</span>
                  <span className="border-border-subtle bg-surface-elevated text-text-muted rounded px-1 py-0.5 text-[0.5625rem]">
                    View Leases
                  </span>
                </DropdownMenuItem>
              )}

              <DropdownMenuSeparator />

              <DropdownMenuItem
                onClick={() => navigate(jobsByWorkerPath(worker.id))}
                className="text-text-primary justify-between"
              >
                <span>View Worker Jobs</span>
                <span className="border-border-subtle bg-surface-elevated text-text-muted rounded px-1 py-0.5 text-[0.5625rem]">
                  GET /jobs
                </span>
              </DropdownMenuItem>

              <DropdownMenuItem
                disabled
                title="Backend capability pending: DELETE /workers/:id"
                className="text-text-disabled cursor-not-allowed justify-between"
              >
                <span className="text-status-danger-text/60">
                  Deregister Worker
                </span>
                <span className="border-border-subtle bg-surface-elevated text-text-muted rounded px-1 py-0.5 text-[0.5625rem]">
                  API Pending
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Operational Summary Metric Strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {/* Concurrency Slots & Utilization */}
        <Card className="border-border-subtle bg-surface-base">
          <CardHeader className="p-3 pb-1">
            <CardTitle className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
              Concurrency Slots
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div className="flex items-baseline gap-1.5">
              <span className="text-text-primary text-xl font-semibold tabular-nums">
                {worker.inFlight}
              </span>
              <span className="text-text-muted text-xs tabular-nums">
                / {worker.maxConcurrency} slots
              </span>
              <span className="text-text-muted ml-auto text-xs tabular-nums">
                {utilPct}%
              </span>
            </div>
            <div className="bg-surface-elevated mt-2 h-1.5 w-full overflow-hidden rounded-full">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-300',
                  utilPct > 85
                    ? 'bg-status-warning-solid'
                    : 'bg-status-success-solid',
                )}
                style={{ width: `${utilPct}%` }}
              />
            </div>
          </CardContent>
        </Card>

        {/* Heartbeat & Sweeper Cadence */}
        <Card className="border-border-subtle bg-surface-base">
          <CardHeader className="p-3 pb-1">
            <CardTitle className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
              Heartbeat Health
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div
              className={cn(
                'text-xl font-semibold tabular-nums',
                isStale ? 'text-status-warning-text' : 'text-text-primary',
              )}
              title={`Last received: ${formatDateTimeUTC(worker.lastHeartbeatAt)}`}
            >
              {formatRelative(worker.lastHeartbeatAt)}
            </div>
            <div className="text-text-muted mt-1 text-[0.6875rem] tabular-nums">
              every {worker.heartbeatIntervalSeconds}s · sweeper:{' '}
              {worker.heartbeatIntervalSeconds * 3}s
            </div>
          </CardContent>
        </Card>

        {/* Runtime & Uptime */}
        <Card className="border-border-subtle bg-surface-base">
          <CardHeader className="p-3 pb-1">
            <CardTitle className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
              Uptime
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div className="text-text-primary text-xl font-semibold tabular-nums">
              {formatUptime(worker.startedAt)}
            </div>
            <div
              className="text-text-muted mt-1 text-[0.6875rem] tabular-nums"
              title={`Started: ${formatDateTimeUTC(worker.startedAt)}`}
            >
              Started {formatRelative(worker.startedAt)}
            </div>
          </CardContent>
        </Card>

        {/* Total Processed Throughput */}
        <Card className="border-border-subtle bg-surface-base">
          <CardHeader className="p-3 pb-1">
            <CardTitle className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
              Total Processed
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div className="text-text-primary font-mono text-xl font-semibold tabular-nums">
              {worker.totalProcessed.toLocaleString()}
            </div>
            <div className="text-text-muted mt-1 text-[0.6875rem]">
              Cumulative completed jobs
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Subscribed Queues & Registered Handlers */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* Queues Card */}
        <Card className="border-border-subtle bg-surface-base">
          <CardHeader className="p-4 pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
                Subscribed Queues ({worker.queues.length})
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="p-4 pt-1">
            {worker.queues.length === 0 ? (
              <p className="text-text-muted text-xs">
                No subscribed queues found.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {worker.queues.map((q) => (
                  <Link
                    key={q}
                    to={jobsByQueuePath(q)}
                    className="border-border-subtle bg-surface-canvas text-text-primary hover:border-border-strong hover:bg-surface-elevated rounded px-2 py-1 font-mono text-xs transition-colors"
                    title={`View jobs in queue: ${q}`}
                  >
                    {q}
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Handlers Card */}
        <Card className="border-border-subtle bg-surface-base">
          <CardHeader className="p-4 pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
                Registered Handlers ({worker.handlers.length})
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="p-4 pt-1">
            {worker.handlers.length === 0 ? (
              <p className="text-text-muted text-xs">
                No registered handlers found.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {worker.handlers.map((h) => (
                  <Link
                    key={h}
                    to={jobsByHandlerPath(h)}
                    className="border-border-subtle bg-surface-canvas text-text-primary hover:border-border-strong hover:bg-surface-elevated rounded px-2 py-1 font-mono text-xs transition-colors"
                    title={`View jobs handled by: ${h}`}
                  >
                    {h}
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Active Running Leases Section */}
      <div id="active-leases-section" className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-text-primary text-sm font-semibold tracking-tight">
              Active Running Leases
            </h3>
            <p className="text-text-muted text-xs">
              {worker.leases.length} active lease
              {worker.leases.length === 1 ? '' : 's'} held by this worker
              runtime
            </p>
          </div>
          <Link
            to={jobsByWorkerPath(worker.id)}
            className="text-text-muted hover:text-text-primary inline-flex items-center gap-1 text-xs transition-colors"
          >
            <span>View All Worker Jobs</span>
            <span aria-hidden="true">&rarr;</span>
          </Link>
        </div>

        <div className="border-border-subtle bg-surface-base overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow className="border-border-subtle bg-surface-canvas/60">
                <TableHead className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
                  Job ID
                </TableHead>
                <TableHead className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
                  Handler
                </TableHead>
                <TableHead className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
                  Queue
                </TableHead>
                <TableHead className="text-text-muted text-right text-[0.6875rem] font-medium tracking-wider uppercase">
                  Attempt
                </TableHead>
                <TableHead className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
                  Leased At
                </TableHead>
                <TableHead className="text-text-muted text-right text-[0.6875rem] font-medium tracking-wider uppercase">
                  Lease TTL Remaining
                </TableHead>
                <TableHead className="text-text-muted text-right text-[0.6875rem] font-medium tracking-wider uppercase">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {worker.leases.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-text-muted py-8 text-center text-xs"
                  >
                    No active leases. Worker is idle and ready for work.
                  </TableCell>
                </TableRow>
              ) : (
                worker.leases.map((l) => {
                  const ttl = formatLeaseTimeRemaining(l.leaseExpiresAt);
                  return (
                    <TableRow
                      key={l.jobId}
                      className="border-border-subtle hover:bg-surface-elevated/60 group cursor-pointer transition-colors"
                      onClick={() => navigate(jobDetailPath(l.jobId))}
                    >
                      {/* Job ID */}
                      <TableCell className="py-2.5">
                        <div className="flex items-center gap-1.5">
                          <span className="text-text-primary font-mono text-xs font-medium underline underline-offset-2">
                            {l.jobId}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCopy(l.jobId, `job-${l.jobId}`);
                            }}
                            className="text-text-muted hover:text-text-primary p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                            title="Copy Job ID"
                            aria-label="Copy Job ID"
                          >
                            <HugeiconsIcon
                              icon={
                                copiedKey === `job-${l.jobId}`
                                  ? Tick01Icon
                                  : Copy01Icon
                              }
                              className={cn(
                                'h-3 w-3',
                                copiedKey === `job-${l.jobId}` &&
                                  'text-status-success-text',
                              )}
                            />
                          </button>
                        </div>
                      </TableCell>

                      {/* Handler */}
                      <TableCell className="py-2.5">
                        <Link
                          to={jobsByHandlerPath(l.handler)}
                          onClick={(e) => e.stopPropagation()}
                          className="text-text-secondary hover:text-text-primary font-mono text-xs transition-colors"
                        >
                          {l.handler}
                        </Link>
                      </TableCell>

                      {/* Queue */}
                      <TableCell className="py-2.5">
                        <Link
                          to={jobsByQueuePath(l.queue)}
                          onClick={(e) => e.stopPropagation()}
                          className="border-border-subtle bg-surface-canvas text-text-secondary hover:border-border-strong rounded px-1.5 py-0.5 font-mono text-[0.625rem] transition-colors"
                        >
                          {l.queue}
                        </Link>
                      </TableCell>

                      {/* Attempt */}
                      <TableCell className="text-text-muted py-2.5 text-right font-mono text-xs tabular-nums">
                        #{l.attempt}
                      </TableCell>

                      {/* Leased At */}
                      <TableCell className="py-2.5">
                        <span
                          className="text-text-muted text-xs tabular-nums"
                          title={`Leased at: ${formatDateTimeUTC(l.leasedAt)}`}
                        >
                          {formatRelative(l.leasedAt)}
                        </span>
                      </TableCell>

                      {/* Lease Remaining TTL */}
                      <TableCell className="py-2.5 text-right font-mono text-xs tabular-nums">
                        <span
                          className={cn(
                            ttl.expired
                              ? 'text-status-danger-text font-medium'
                              : ttl.remainingMs < 5000
                                ? 'text-status-warning-text'
                                : 'text-text-primary',
                          )}
                          title={`Expires: ${formatDateTimeUTC(l.leaseExpiresAt)}`}
                        >
                          {ttl.label}
                        </span>
                      </TableCell>

                      {/* Actions */}
                      <TableCell className="py-2.5 text-right">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setReleaseTargetLease(l);
                          }}
                          className="border-status-danger-border/60 text-status-danger-text hover:bg-status-danger-bg hover:border-status-danger-border h-6 px-2 text-xs transition-colors"
                          title={`Force-release lease for job ${l.jobId}`}
                        >
                          Release
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Historical Jobs Notice */}
      <div className="border-border-subtle bg-surface-canvas/50 text-text-muted flex items-start gap-2.5 rounded-md border p-3.5 text-xs">
        <HugeiconsIcon
          icon={Activity01Icon}
          className="text-text-secondary mt-0.5 h-4 w-4 shrink-0"
        />
        <div className="space-y-1">
          <p className="text-text-primary font-medium">
            Historical Job Execution Log
          </p>
          <p className="text-text-muted leading-relaxed">
            Historical jobs executed by this worker can be viewed in the{' '}
            <Link
              to={ROUTES.jobs}
              className="text-text-primary font-medium underline underline-offset-2 hover:opacity-80"
            >
              Jobs Console
            </Link>
            . Dedicated per-worker historical filtering (e.g.,{' '}
            <code className="bg-surface-elevated rounded px-1 py-0.5 font-mono text-[0.6875rem]">
              GET /jobs?worker_id=...
            </code>
            ) is logged for future backend implementation.
          </p>
        </div>
      </div>

      {/* Force-Release Lease Confirmation Dialog */}
      <Dialog
        open={!!releaseTargetLease}
        onOpenChange={(open) => {
          if (!open && !releaseLeaseMutation.isPending) {
            setReleaseTargetLease(null);
          }
        }}
      >
        <DialogContent className="border-border-strong bg-surface-base sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Force-Release Active Lease</DialogTitle>
            <DialogDescription>
              Are you sure you want to force-release this active lease from
              worker{' '}
              <span className="text-text-primary font-mono font-medium">
                {worker.hostname}
              </span>
              ?
            </DialogDescription>
          </DialogHeader>

          {releaseTargetLease && (
            <div className="space-y-3">
              <div className="border-border-subtle bg-surface-canvas/50 space-y-2 rounded-md border p-3 text-xs">
                <div className="flex justify-between">
                  <span className="text-text-muted">Job ID:</span>
                  <span className="text-text-primary font-mono font-medium">
                    {releaseTargetLease.jobId}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">Handler:</span>
                  <span className="text-text-primary font-mono">
                    {releaseTargetLease.handler}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">Queue:</span>
                  <span className="text-text-primary font-mono">
                    {releaseTargetLease.queue}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">Attempt:</span>
                  <span className="text-text-primary font-mono">
                    #{releaseTargetLease.attempt}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">Worker ID:</span>
                  <span
                    className="text-text-muted max-w-[200px] truncate font-mono"
                    title={worker.id}
                  >
                    {worker.id}
                  </span>
                </div>
              </div>

              <div className="border-status-warning-border/60 bg-status-warning-bg/40 text-status-warning-text rounded-md border p-2.5 text-xs">
                The job will immediately return to{' '}
                <code className="font-mono font-semibold">queued</code> status
                with its worker assignment cleared, allowing another worker to
                dequeue it.
              </div>

              {releaseLeaseMutation.isError && (
                <div
                  role="alert"
                  className="border-status-danger-border bg-status-danger-bg text-status-danger-text rounded-md border p-2.5 text-xs"
                >
                  {releaseLeaseMutation.error?.message ??
                    'Failed to release lease'}
                </div>
              )}
            </div>
          )}

          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setReleaseTargetLease(null)}
              disabled={releaseLeaseMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleConfirmRelease}
              disabled={releaseLeaseMutation.isPending}
            >
              {releaseLeaseMutation.isPending
                ? 'Releasing…'
                : 'Confirm Release'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Breadcrumb({
  id,
  hostname,
}: {
  id: string | undefined;
  hostname: string | undefined;
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <Link
        to={ROUTES.workers}
        className="text-text-muted hover:text-text-primary flex items-center gap-1 transition-colors"
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} className="h-3 w-3" />
        <span>Workers</span>
      </Link>
      <span className="text-text-muted">/</span>
      <span className="text-text-primary font-mono text-xs font-medium">
        {hostname ?? id ?? '—'}
      </span>
      {hostname && id && (
        <span className="text-text-muted font-mono text-[0.6875rem]">
          (…{id.slice(-8)})
        </span>
      )}
    </div>
  );
}
