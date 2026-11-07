import { Badge, type BadgeTone } from '@/components/ui/badge';
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
import { formatClockUTC, formatDurationMs, formatRelative } from '@/lib/format';
import {
  ROUTES,
  jobDetailPath,
  jobsByQueuePath,
  jobsByStatusPath,
  workerDetailPath,
} from '@/lib/routes';
import type { WorkerState } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  Activity01Icon,
  Add01Icon,
  AlertCircleIcon,
  Cancel01Icon,
  ServerStack01Icon,
  Task01Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ComponentProps } from 'react';
import { Link, useNavigate } from 'react-router-dom';

type IconRef = ComponentProps<typeof HugeiconsIcon>['icon'];

const WORKER_STATE_TONE: Record<WorkerState, BadgeTone> = {
  active: 'success',
  idle: 'muted',
  draining: 'info',
  disconnected: 'danger',
};

const WORKER_STATE_LABEL: Record<WorkerState, string> = {
  active: 'Active',
  idle: 'Idle',
  draining: 'Draining',
  disconnected: 'Disconnected',
};

export function DashboardPage() {
  const navigate = useNavigate();

  const stats = useQueueStats();
  const workers = useWorkers();
  const recentJobs = useJobsList({ limit: 8, offset: 0 });

  const totals = stats.data?.totals;
  const waiting = totals ? totals.queued + totals.scheduled : null;
  const needsAttention = totals ? totals.failed + totals.deadLettered : null;

  const liveWorkers = workers.data
    ? workers.data.workers.filter(
        (w) => w.state === 'active' || w.state === 'idle',
      )
    : [];
  const activeWorkers = workers.data ? liveWorkers.length : null;
  const disconnectedWorkers = workers.data
    ? workers.data.workers.filter((w) => w.state === 'disconnected').length
    : 0;

  const isRefreshing =
    stats.isFetching || workers.isFetching || recentJobs.isFetching;
  const hasJobs =
    totals != null &&
    totals.queued +
      totals.scheduled +
      totals.running +
      totals.succeeded +
      totals.failed +
      totals.deadLettered +
      totals.cancelled >
      0;

  const systemOk =
    needsAttention === 0 &&
    activeWorkers !== null &&
    activeWorkers > 0 &&
    !stats.isError &&
    !workers.isError;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">Overview</h2>
          <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="inline-flex items-center gap-1.5">
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  stats.isError || workers.isError
                    ? 'bg-destructive'
                    : systemOk
                      ? 'bg-emerald-500'
                      : 'bg-amber-500',
                )}
                aria-hidden
              />
              {stats.isError || workers.isError
                ? 'API unreachable'
                : systemOk
                  ? 'Healthy'
                  : needsAttention && needsAttention > 0
                    ? 'Needs attention'
                    : activeWorkers === 0
                      ? 'No live workers'
                      : 'Live'}
            </span>
            <span className="text-muted-foreground/50">·</span>
            <span>Refreshes every 5s</span>
            {isRefreshing && (
              <>
                <span className="text-muted-foreground/50">·</span>
                <span className="text-muted-foreground/70">updating…</span>
              </>
            )}
          </p>
        </div>
        <Button asChild size="sm">
          <Link to={ROUTES.jobEnqueue}>
            <HugeiconsIcon icon={Add01Icon} data-icon="inline-start" />
            Enqueue job
          </Link>
        </Button>
      </div>

      {(stats.isError || workers.isError) && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs"
        >
          {stats.isError && (
            <div>Could not load queue stats: {stats.error?.message}</div>
          )}
          {workers.isError && (
            <div>Could not load workers: {workers.error?.message}</div>
          )}
          <p className="text-destructive/80 mt-1">
            Check that the API is running and the Vite proxy target matches its
            port.
          </p>
        </div>
      )}

      {!stats.isLoading &&
        !workers.isLoading &&
        activeWorkers === 0 &&
        !workers.isError && (
          <div
            role="status"
            className="border-border bg-muted/40 rounded-md border px-3 py-2 text-xs"
          >
            No workers are online. Jobs will sit queued until a worker process
            starts and heartbeats.
          </div>
        )}

      <section
        aria-label="Job counts"
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
      >
        <MetricLink
          to={jobsByStatusPath('queued', 'scheduled')}
          label="Waiting"
          hint="Queued + scheduled"
          value={waiting}
          icon={Task01Icon}
          loading={stats.isLoading}
        />
        <MetricLink
          to={jobsByStatusPath('running')}
          label="Running"
          hint="In flight now"
          value={totals?.running ?? null}
          icon={Activity01Icon}
          loading={stats.isLoading}
        />
        <MetricLink
          to={jobsByStatusPath('failed')}
          label="Failed"
          hint="Retrying soon"
          value={totals?.failed ?? null}
          icon={AlertCircleIcon}
          loading={stats.isLoading}
          tone={totals && totals.failed > 0 ? 'warn' : 'default'}
        />
        <MetricLink
          to={jobsByStatusPath('dead-lettered')}
          label="Dead-lettered"
          hint="Gave up"
          value={totals?.deadLettered ?? null}
          icon={Cancel01Icon}
          loading={stats.isLoading}
          tone={totals && totals.deadLettered > 0 ? 'danger' : 'default'}
        />
        <MetricLink
          to={ROUTES.workers}
          label="Workers"
          hint={
            disconnectedWorkers > 0
              ? `${disconnectedWorkers} disconnected`
              : 'Accepting work'
          }
          value={activeWorkers}
          icon={ServerStack01Icon}
          loading={workers.isLoading}
          tone={activeWorkers === 0 ? 'warn' : 'default'}
        />
      </section>

      {totals && hasJobs && (
        <StatusStrip
          items={[
            {
              label: 'Waiting',
              count: waiting ?? 0,
              href: jobsByStatusPath('queued', 'scheduled'),
            },
            {
              label: 'Running',
              count: totals.running,
              href: jobsByStatusPath('running'),
            },
            {
              label: 'Succeeded',
              count: totals.succeeded,
              href: jobsByStatusPath('succeeded'),
            },
            {
              label: 'Failed',
              count: totals.failed,
              href: jobsByStatusPath('failed'),
            },
            {
              label: 'DLQ',
              count: totals.deadLettered,
              href: jobsByStatusPath('dead-lettered'),
            },
            {
              label: 'Cancelled',
              count: totals.cancelled,
              href: jobsByStatusPath('cancelled'),
            },
          ]}
        />
      )}

      <section className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Queues</CardTitle>
            <Link
              to={ROUTES.jobs}
              className="text-muted-foreground hover:text-foreground text-[0.6875rem]"
            >
              All jobs
            </Link>
          </CardHeader>
          <CardContent className="px-0 pb-1">
            {stats.isLoading ? (
              <p className="text-muted-foreground px-4 py-3 text-xs">
                Loading…
              </p>
            ) : !stats.data || stats.data.queues.length === 0 ? (
              <EmptyBlock
                title="No queue activity yet"
                body="Enqueue a job to create a queue name and see depth here."
                actionHref={ROUTES.jobEnqueue}
                actionLabel="Enqueue job"
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead className="text-right">Waiting</TableHead>
                    <TableHead className="text-right">Running</TableHead>
                    <TableHead className="text-right">24h OK</TableHead>
                    <TableHead className="text-right">24h fail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stats.data.queues.map((q) => (
                    <TableRow
                      key={q.name}
                      className="hover:bg-muted/40 cursor-pointer"
                      onClick={() => navigate(jobsByQueuePath(q.name))}
                    >
                      <TableCell className="font-mono text-[0.6875rem]">
                        {q.name}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {q.depth}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {q.inFlight}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right tabular-nums">
                        {q.succeeded24h}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right tabular-nums',
                          q.failed24h + q.deadLettered24h > 0
                            ? 'text-destructive'
                            : 'text-muted-foreground',
                        )}
                      >
                        {q.failed24h + q.deadLettered24h}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Workers</CardTitle>
            <Link
              to={ROUTES.workers}
              className="text-muted-foreground hover:text-foreground text-[0.6875rem]"
            >
              View all
            </Link>
          </CardHeader>
          <CardContent className="px-0 pb-1">
            {workers.isLoading ? (
              <p className="text-muted-foreground px-4 py-3 text-xs">
                Loading…
              </p>
            ) : !workers.data || workers.data.workers.length === 0 ? (
              <EmptyBlock
                title="No workers registered"
                body="Start the worker process so jobs can be claimed and executed."
              />
            ) : (
              <ul className="divide-border divide-y">
                {workers.data.workers.slice(0, 8).map((w) => (
                  <li key={w.id}>
                    <Link
                      to={workerDetailPath(w.id)}
                      className="hover:bg-muted/40 flex items-center justify-between gap-3 px-4 py-2.5 text-xs transition-colors"
                    >
                      <div className="min-w-0 space-y-0.5">
                        <div className="truncate font-mono text-[0.6875rem]">
                          {w.hostname}
                        </div>
                        <div className="text-muted-foreground truncate text-[0.625rem]">
                          {w.handlers.length > 0
                            ? w.handlers.join(', ')
                            : 'no handlers'}
                          {' · '}
                          heartbeat {formatRelative(w.lastHeartbeatAt)}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span
                          className="text-muted-foreground tabular-nums"
                          title="In flight / max concurrency"
                        >
                          {w.inFlight}/{w.maxConcurrency}
                        </span>
                        <Badge tone={WORKER_STATE_TONE[w.state]}>
                          {WORKER_STATE_LABEL[w.state]}
                        </Badge>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>

      <section className="space-y-2">
        <div className="flex items-end justify-between gap-2">
          <h3 className="text-sm font-medium">Recent jobs</h3>
          <Link
            to={ROUTES.jobs}
            className="text-muted-foreground hover:text-foreground text-[0.6875rem]"
          >
            View all jobs
          </Link>
        </div>
        <div className="border-border overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job</TableHead>
                <TableHead>Handler</TableHead>
                <TableHead>Queue</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Enqueued</TableHead>
                <TableHead className="text-right">Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentJobs.isLoading ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-muted-foreground py-6 text-center text-xs"
                  >
                    Loading…
                  </TableCell>
                </TableRow>
              ) : recentJobs.data?.jobs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-8">
                    <EmptyBlock
                      title="No jobs yet"
                      body="Create an http_request job to see it appear here within a few seconds."
                      actionHref={ROUTES.jobEnqueue}
                      actionLabel="Enqueue job"
                    />
                  </TableCell>
                </TableRow>
              ) : (
                recentJobs.data?.jobs.map((j) => {
                  const lastAttempt = j.attempts[j.attempts.length - 1];
                  return (
                    <TableRow
                      key={j.id}
                      className="hover:bg-muted/40 cursor-pointer"
                      onClick={() => navigate(jobDetailPath(j.id))}
                    >
                      <TableCell
                        className="font-mono text-[0.6875rem]"
                        title={j.id}
                      >
                        …{j.id.slice(-10)}
                      </TableCell>
                      <TableCell className="font-mono text-[0.6875rem]">
                        {j.handler}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {j.queue}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={j.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground tabular-nums">
                        {formatClockUTC(j.enqueuedAt)}
                        <span className="text-muted-foreground/70 ml-1">
                          ({formatRelative(j.enqueuedAt)})
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatDurationMs(lastAttempt?.durationMs ?? null)}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}

function MetricLink({
  to,
  label,
  hint,
  value,
  icon,
  loading,
  tone = 'default',
}: {
  to: string;
  label: string;
  hint: string;
  value: number | null;
  icon: IconRef;
  loading: boolean;
  tone?: 'default' | 'warn' | 'danger';
}) {
  const hot =
    (tone === 'danger' || tone === 'warn') && value != null && value > 0;

  return (
    <Link
      to={to}
      className={cn(
        'border-border bg-card hover:bg-muted/40 focus-visible:ring-ring/30 block rounded-md border p-3 transition-colors outline-none focus-visible:ring-2',
        hot && tone === 'danger' && 'border-destructive/30',
        hot && tone === 'warn' && 'border-amber-500/30',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-muted-foreground text-[0.6875rem] font-medium">
          {label}
        </div>
        <HugeiconsIcon
          icon={icon}
          size={14}
          className={cn(
            'text-muted-foreground',
            hot && tone === 'danger' && 'text-destructive',
            hot && tone === 'warn' && 'text-amber-600',
          )}
        />
      </div>
      <div
        className={cn(
          'mt-1 text-2xl font-semibold tracking-tight tabular-nums',
          hot && tone === 'danger' && 'text-destructive',
          hot && tone === 'warn' && 'text-amber-700',
        )}
      >
        {loading ? (
          <span className="text-muted-foreground text-base">…</span>
        ) : value === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          value.toLocaleString()
        )}
      </div>
      <div className="text-muted-foreground mt-0.5 text-[0.625rem]">{hint}</div>
    </Link>
  );
}

function StatusStrip({
  items,
}: {
  items: { label: string; count: number; href: string }[];
}) {
  const total = items.reduce((sum, i) => sum + i.count, 0);
  if (total === 0) return null;

  return (
    <div className="border-border space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Pipeline</span>
        <span className="text-muted-foreground inline-flex items-center gap-1 text-[0.6875rem]">
          <HugeiconsIcon icon={Tick02Icon} size={12} />
          {total.toLocaleString()} jobs total
        </span>
      </div>
      <div className="bg-muted flex h-2 overflow-hidden rounded-full">
        {items.map((item) => {
          if (item.count === 0) return null;
          const pct = (item.count / total) * 100;
          return (
            <Link
              key={item.label}
              to={item.href}
              title={`${item.label}: ${item.count}`}
              className={cn(
                'h-full min-w-[2px] transition-opacity hover:opacity-80',
                item.label === 'Waiting' && 'bg-slate-400',
                item.label === 'Running' && 'bg-blue-500',
                item.label === 'Succeeded' && 'bg-emerald-500',
                item.label === 'Failed' && 'bg-red-500',
                item.label === 'DLQ' && 'bg-amber-500',
                item.label === 'Cancelled' && 'bg-slate-300',
              )}
              style={{ width: `${pct}%` }}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {items.map((item) => (
          <Link
            key={item.label}
            to={item.href}
            className="text-muted-foreground hover:text-foreground text-[0.625rem] tabular-nums"
          >
            <span className="text-foreground font-medium">
              {item.count.toLocaleString()}
            </span>{' '}
            {item.label}
          </Link>
        ))}
      </div>
    </div>
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
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground max-w-sm text-xs">{body}</p>
      {actionHref && actionLabel && (
        <Button asChild size="sm" variant="outline" className="mt-1">
          <Link to={actionHref}>{actionLabel}</Link>
        </Button>
      )}
    </div>
  );
}
