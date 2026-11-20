import { JobCancelDialog } from '@/components/jobs/job-cancel-dialog';
import { JobInspectorDrawer } from '@/components/jobs/job-inspector-drawer';
import { QuickEnqueueDialog } from '@/components/jobs/quick-enqueue-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { StatusBadge, type JobStatus } from '@/components/ui/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useJobsList, useQueueStats } from '@/hooks/api';
import {
  formatClockUTC,
  formatDateTimeUTC,
  formatRelative,
} from '@/lib/format';
import {
  computeJobsMetrics,
  extractQueueOptions,
  formatAttemptRatio,
  getPriorityMeta,
  inferTabFromStatuses,
  isJobCancellable,
  mapTabToStatuses,
  type JobFilterTab,
} from '@/lib/jobs-helpers';
import { jobDetailPath, ROUTES } from '@/lib/routes';
import { KNOWN_HANDLERS, type Job } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  Add01Icon,
  Alert02Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Copy01Icon,
  MoreHorizontalIcon,
  Refresh01Icon,
  Search01Icon,
  ServerStack01Icon,
  Tick01Icon,
  ViewIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

const PAGE_SIZE = 50;

const ALL_STATUSES: JobStatus[] = [
  'queued',
  'running',
  'scheduled',
  'succeeded',
  'failed',
  'dead-lettered',
  'cancelled',
];

const FILTER_TABS: Array<{ id: JobFilterTab; label: string }> = [
  { id: 'all', label: 'All Jobs' },
  { id: 'active', label: 'Active' },
  { id: 'queued', label: 'Queued' },
  { id: 'running', label: 'Running' },
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'failed', label: 'Failed' },
  { id: 'dead-lettered', label: 'Dead-lettered' },
  { id: 'succeeded', label: 'Succeeded' },
  { id: 'cancelled', label: 'Cancelled' },
];

export function JobsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const stats = useQueueStats();

  // URL search parameter parsing
  const statuses = useMemo(
    () => parseStatusParams(searchParams.getAll('status')),
    [searchParams],
  );
  const queues = useMemo(
    () =>
      searchParams
        .getAll('queue')
        .map((s) => s.trim())
        .filter(Boolean),
    [searchParams],
  );
  const handlers = useMemo(
    () =>
      searchParams
        .getAll('handler')
        .map((s) => s.trim())
        .filter(Boolean),
    [searchParams],
  );
  const search = searchParams.get('search')?.trim() ?? '';
  const page = Math.max(0, Number(searchParams.get('page') ?? 0) | 0);
  const offset = page * PAGE_SIZE;

  // Primary list query
  const { data, isLoading, isFetching, isError, error, refetch } = useJobsList({
    limit: PAGE_SIZE,
    offset,
    statuses: statuses.length > 0 ? statuses : undefined,
    queues: queues.length > 0 ? queues : undefined,
    handlers: handlers.length > 0 ? handlers : undefined,
    search: search || undefined,
  });

  const jobs = data?.jobs ?? [];
  const total = data?.totalCount ?? 0;
  const firstShown = total === 0 ? 0 : offset + 1;
  const lastShown = Math.min(offset + jobs.length, total);
  const hasPrev = page > 0;
  const hasNext = offset + jobs.length < total;

  // Active operational KPI metrics
  const metrics = useMemo(
    () => computeJobsMetrics(stats.data, total),
    [stats.data, total],
  );

  // Queue options extracted from stats + currently selected
  const queueOptions = useMemo(
    () => extractQueueOptions(stats.data?.queues ?? [], queues[0]),
    [stats.data?.queues, queues],
  );

  // Active Filter Tab inferred from query
  const activeTab = useMemo(() => inferTabFromStatuses(statuses), [statuses]);

  // Modal & Drawer State
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [cancellingJob, setCancellingJob] = useState<Job | null>(null);
  const [isEnqueueOpen, setIsEnqueueOpen] = useState(false);

  // 1-click copy feedback state
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const handleCopy = useCallback((text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((curr) => (curr === key ? null : curr));
    }, 2000);
  }, []);

  // Filter mutation helpers preserving search params ergonomics
  const updateFilter = useCallback(
    (mut: (sp: URLSearchParams) => void) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          mut(next);
          next.delete('page');
          return next;
        },
        { replace: false },
      );
    },
    [setSearchParams],
  );

  const selectTab = useCallback(
    (tab: JobFilterTab) => {
      updateFilter((sp) => {
        sp.delete('status');
        const mapped = mapTabToStatuses(tab);
        if (mapped) {
          for (const s of mapped) {
            sp.append('status', s);
          }
        }
      });
    },
    [updateFilter],
  );

  const clearFilters = useCallback(() => {
    setSearchParams({}, { replace: false });
  }, [setSearchParams]);

  const hasFilters =
    statuses.length > 0 ||
    queues.length > 0 ||
    handlers.length > 0 ||
    search.length > 0;

  const goToPage = (p: number) =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (p <= 0) next.delete('page');
      else next.set('page', String(p));
      return next;
    });

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-text-primary text-base font-semibold tracking-tight">
            Jobs
          </h2>
          <p className="text-text-muted text-xs">
            {isLoading ? (
              'Loading queue state…'
            ) : (
              <>
                Showing{' '}
                <span className="text-text-primary font-medium tabular-nums">
                  {firstShown.toLocaleString()}–{lastShown.toLocaleString()}
                </span>{' '}
                of{' '}
                <span className="text-text-primary font-medium tabular-nums">
                  {total.toLocaleString()}
                </span>{' '}
                job{total === 1 ? '' : 's'}
              </>
            )}
            {isFetching && !isLoading && (
              <span className="text-text-muted/60 ml-2 inline-flex items-center gap-1 text-[0.625rem]">
                <span className="bg-status-info-solid inline-block h-1.5 w-1.5 rounded-full" />
                refreshing live…
              </span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => setIsEnqueueOpen(true)}
            className="text-xs"
          >
            <HugeiconsIcon icon={Add01Icon} className="mr-1.5 h-3.5 w-3.5" />
            Enqueue Job
          </Button>

          <Button
            asChild
            variant="outline"
            size="sm"
            className="text-xs"
            title="Open guided multi-step enqueue builder"
          >
            <Link to={ROUTES.jobEnqueue}>Full Form</Link>
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                title="Batch and bulk queue operations"
              >
                <span>Bulk Actions</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 text-xs">
              <DropdownMenuLabel>Queue Batch Operations</DropdownMenuLabel>
              <DropdownMenuItem
                disabled
                title="Backend capability pending: POST /jobs/bulk-cancel"
                className="text-text-disabled cursor-not-allowed justify-between"
              >
                <span>Bulk Cancel Jobs</span>
                <span className="border-border-subtle bg-surface-elevated text-text-muted rounded px-1 py-0.5 text-[0.5625rem]">
                  API Pending
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled
                title="Backend capability pending: POST /jobs/bulk-retry"
                className="text-text-disabled cursor-not-allowed justify-between"
              >
                <span>Bulk Retry Failed</span>
                <span className="border-border-subtle bg-surface-elevated text-text-muted rounded px-1 py-0.5 text-[0.5625rem]">
                  API Pending
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled
                title="Backend capability pending: DELETE /jobs/dlq"
                className="text-text-disabled cursor-not-allowed justify-between"
              >
                <span>Purge Dead-Letter Queue</span>
                <span className="border-border-subtle bg-surface-elevated text-text-muted rounded px-1 py-0.5 text-[0.5625rem]">
                  API Pending
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            className="text-xs"
            title="Force refresh queue jobs"
          >
            <HugeiconsIcon
              icon={Refresh01Icon}
              className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')}
            />
            Refresh
          </Button>
        </div>
      </div>

      {/* Error Alert Banner */}
      {isError && (
        <div
          role="alert"
          className="border-status-danger-border bg-status-danger-bg text-status-danger-text flex items-center justify-between rounded-md border px-3.5 py-2.5 text-xs"
        >
          <div className="flex items-center gap-2">
            <HugeiconsIcon icon={Alert02Icon} className="h-4 w-4 shrink-0" />
            <span>
              Failed to load jobs: {error?.message ?? 'Internal server error'}
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
      )}

      {/* 5-Card Operational Queue State KPI Strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {/* Total In Queue / System */}
        <Card
          onClick={() => selectTab('all')}
          className={cn(
            'border-border-subtle bg-surface-base hover:border-border-strong cursor-pointer transition-colors',
            activeTab === 'all' &&
              'border-border-strong ring-border-strong/20 ring-1',
          )}
        >
          <CardHeader className="p-3 pb-1">
            <CardTitle className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
              Total In System
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div className="text-text-primary text-xl font-semibold tracking-tight tabular-nums">
              {metrics.total.toLocaleString()}
            </div>
            <div className="text-text-muted mt-0.5 text-[0.6875rem]">
              All queue records
            </div>
          </CardContent>
        </Card>

        {/* Active Workload (Queued + Running + Scheduled) */}
        <Card
          onClick={() => selectTab('active')}
          className={cn(
            'border-border-subtle bg-surface-base hover:border-border-strong cursor-pointer transition-colors',
            activeTab === 'active' &&
              'border-status-info-border ring-status-info-border/30 ring-1',
          )}
        >
          <CardHeader className="p-3 pb-1">
            <CardTitle className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
              Active Workload
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div className="text-status-info-text text-xl font-semibold tracking-tight tabular-nums">
              {metrics.active.toLocaleString()}
            </div>
            <div className="text-text-muted mt-0.5 text-[0.6875rem] tabular-nums">
              {metrics.queued} queued · {metrics.running} running
            </div>
          </CardContent>
        </Card>

        {/* In-Flight Leased Executions */}
        <Card
          onClick={() => selectTab('running')}
          className={cn(
            'border-border-subtle bg-surface-base hover:border-border-strong cursor-pointer transition-colors',
            activeTab === 'running' &&
              'border-status-info-border ring-status-info-border/30 ring-1',
          )}
        >
          <CardHeader className="p-3 pb-1">
            <CardTitle className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
              Running Leases
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div className="text-status-info-text text-xl font-semibold tracking-tight tabular-nums">
              {metrics.running.toLocaleString()}
            </div>
            <div className="text-text-muted mt-0.5 text-[0.6875rem]">
              {metrics.running > 0
                ? 'Active worker leases'
                : 'Zero active executions'}
            </div>
          </CardContent>
        </Card>

        {/* Attention Required (Failed + Dead-lettered) */}
        <Card
          onClick={() => selectTab('failed')}
          className={cn(
            'border-border-subtle bg-surface-base hover:border-border-strong cursor-pointer transition-colors',
            (activeTab === 'failed' || activeTab === 'dead-lettered') &&
              'border-status-danger-border ring-status-danger-border/30 ring-1',
          )}
        >
          <CardHeader className="p-3 pb-1">
            <CardTitle className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
              Attention Required
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div
              className={cn(
                'text-xl font-semibold tracking-tight tabular-nums',
                metrics.failed + metrics.deadLettered > 0
                  ? 'text-status-danger-text'
                  : 'text-text-primary',
              )}
            >
              {(metrics.failed + metrics.deadLettered).toLocaleString()}
            </div>
            <div className="text-text-muted mt-0.5 text-[0.6875rem] tabular-nums">
              {metrics.failed} retry pending · {metrics.deadLettered} DLQ
            </div>
          </CardContent>
        </Card>

        {/* Completed / Succeeded */}
        <Card
          onClick={() => selectTab('succeeded')}
          className={cn(
            'border-border-subtle bg-surface-base hover:border-border-strong col-span-2 cursor-pointer transition-colors sm:col-span-1',
            activeTab === 'succeeded' &&
              'border-status-success-border ring-status-success-border/30 ring-1',
          )}
        >
          <CardHeader className="p-3 pb-1">
            <CardTitle className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
              Succeeded
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div className="text-status-success-text text-xl font-semibold tracking-tight tabular-nums">
              {metrics.succeeded.toLocaleString()}
            </div>
            <div className="text-text-muted mt-0.5 text-[0.6875rem]">
              Successfully processed
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Multi-Dimensional Filter Toolbar */}
      <div className="border-border-subtle bg-surface-base space-y-3 rounded-md border p-3.5">
        {/* Status Filter Tabs Strip */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
              Status Filter
            </span>
            {hasFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="text-text-muted hover:text-text-primary text-[0.6875rem] underline-offset-2 hover:underline"
              >
                Reset All Filters
              </button>
            )}
          </div>

          <div
            className="flex flex-wrap items-center gap-1.5"
            role="tablist"
            aria-label="Filter jobs by status"
          >
            {FILTER_TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              const count =
                tab.id === 'all'
                  ? metrics.total
                  : tab.id === 'active'
                    ? metrics.active
                    : tab.id === 'queued'
                      ? metrics.queued
                      : tab.id === 'running'
                        ? metrics.running
                        : tab.id === 'scheduled'
                          ? metrics.scheduled
                          : tab.id === 'failed'
                            ? metrics.failed
                            : tab.id === 'dead-lettered'
                              ? metrics.deadLettered
                              : tab.id === 'succeeded'
                                ? metrics.succeeded
                                : metrics.cancelled;

              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => selectTab(tab.id)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                    isActive
                      ? 'border-border-strong bg-surface-elevated text-text-primary shadow-xs'
                      : 'border-border-subtle bg-surface-base text-text-muted hover:bg-surface-canvas hover:text-text-primary',
                  )}
                >
                  <span>{tab.label}</span>
                  {count !== undefined && count > 0 && (
                    <span
                      className={cn(
                        'py-0.2 rounded-sm px-1 text-[0.625rem] font-semibold tabular-nums',
                        isActive
                          ? 'bg-surface-base text-text-primary'
                          : 'bg-surface-elevated text-text-muted',
                      )}
                    >
                      {count.toLocaleString()}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Queue, Handler & Search Filters */}
        <div className="grid gap-3 pt-1 sm:grid-cols-3">
          {/* Queue Filter */}
          <div className="space-y-1">
            <label
              htmlFor="filter-queue-select"
              className="text-text-muted text-[0.6875rem] font-medium"
            >
              Queue
            </label>
            <select
              id="filter-queue-select"
              value={queues[0] ?? ''}
              onChange={(e) =>
                updateFilter((sp) => {
                  sp.delete('queue');
                  const v = e.target.value.trim();
                  if (v) sp.append('queue', v);
                })
              }
              className="border-border-subtle bg-surface-base text-text-primary focus:border-border-strong h-8 w-full rounded-md border px-2 text-xs focus:outline-hidden"
            >
              <option value="">All Queues ({queueOptions.length})</option>
              {queueOptions.map((q) => (
                <option key={q} value={q}>
                  Queue: {q}
                </option>
              ))}
            </select>
          </div>

          {/* Handler Filter */}
          <div className="space-y-1">
            <label
              htmlFor="filter-handler-select"
              className="text-text-muted text-[0.6875rem] font-medium"
            >
              Handler
            </label>
            <select
              id="filter-handler-select"
              value={handlers[0] ?? ''}
              onChange={(e) =>
                updateFilter((sp) => {
                  sp.delete('handler');
                  const v = e.target.value.trim();
                  if (v) sp.append('handler', v);
                })
              }
              className="border-border-subtle bg-surface-base text-text-primary focus:border-border-strong h-8 w-full rounded-md border px-2 text-xs focus:outline-hidden"
            >
              <option value="">All Handlers ({KNOWN_HANDLERS.length})</option>
              {KNOWN_HANDLERS.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </div>

          {/* Search Input */}
          <div className="space-y-1">
            <label
              htmlFor="filter-search-input"
              className="text-text-muted text-[0.6875rem] font-medium"
            >
              Search Job ID / Handler Prefix
            </label>
            <div className="relative">
              <HugeiconsIcon
                icon={Search01Icon}
                className="text-text-muted absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2"
              />
              <Input
                id="filter-search-input"
                type="text"
                value={search}
                placeholder="Paste Job ULID or handler…"
                onChange={(e) =>
                  updateFilter((sp) => {
                    const v = e.target.value.trim();
                    if (v) sp.set('search', v);
                    else sp.delete('search');
                  })
                }
                className="bg-surface-base border-border-subtle h-8 pr-7 pl-8 font-mono text-xs"
              />
              {search && (
                <button
                  type="button"
                  onClick={() =>
                    updateFilter((sp) => {
                      sp.delete('search');
                    })
                  }
                  className="text-text-muted hover:text-text-primary absolute top-1/2 right-2 -translate-y-1/2"
                  title="Clear search"
                >
                  <HugeiconsIcon icon={Cancel01Icon} className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Main Jobs Table */}
      <div className="border-border-subtle bg-surface-base overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow className="border-border-subtle bg-surface-canvas/60 hover:bg-surface-canvas/60">
              <TableHead className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
                Job ID & Queue
              </TableHead>
              <TableHead className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
                Handler
              </TableHead>
              <TableHead className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
                Status
              </TableHead>
              <TableHead className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
                Priority
              </TableHead>
              <TableHead className="text-text-muted text-right text-[0.6875rem] font-medium tracking-wider uppercase">
                Attempts
              </TableHead>
              <TableHead className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
                Enqueued (UTC)
              </TableHead>
              <TableHead className="text-text-muted text-right text-[0.6875rem] font-medium tracking-wider uppercase">
                Age
              </TableHead>
              <TableHead className="text-text-muted text-right text-[0.6875rem] font-medium tracking-wider uppercase">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              // Skeleton loading state
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow
                  key={`skeleton-job-${i}`}
                  className="border-border-subtle"
                >
                  <TableCell>
                    <div className="bg-surface-elevated h-3.5 w-32 animate-pulse rounded" />
                    <div className="bg-surface-elevated mt-1.5 h-3 w-16 animate-pulse rounded" />
                  </TableCell>
                  <TableCell>
                    <div className="bg-surface-elevated h-3.5 w-24 animate-pulse rounded" />
                  </TableCell>
                  <TableCell>
                    <div className="bg-surface-elevated h-4 w-16 animate-pulse rounded" />
                  </TableCell>
                  <TableCell>
                    <div className="bg-surface-elevated h-3.5 w-10 animate-pulse rounded" />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="bg-surface-elevated ml-auto h-3.5 w-12 animate-pulse rounded" />
                  </TableCell>
                  <TableCell>
                    <div className="bg-surface-elevated h-3.5 w-20 animate-pulse rounded" />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="bg-surface-elevated ml-auto h-3.5 w-14 animate-pulse rounded" />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="bg-surface-elevated ml-auto h-7 w-16 animate-pulse rounded" />
                  </TableCell>
                </TableRow>
              ))
            ) : jobs.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="text-text-muted py-10 text-center text-xs"
                >
                  <div className="mx-auto flex max-w-sm flex-col items-center justify-center space-y-2">
                    <div className="bg-surface-elevated text-text-muted flex h-10 w-10 items-center justify-center rounded-full">
                      <HugeiconsIcon
                        icon={ServerStack01Icon}
                        className="h-5 w-5"
                      />
                    </div>
                    <div className="text-text-primary text-sm font-medium">
                      {hasFilters
                        ? 'No jobs match current filters'
                        : 'Queue is empty'}
                    </div>
                    <p className="text-text-muted text-xs">
                      {hasFilters
                        ? 'Try relaxing status, queue, or search query parameters.'
                        : 'No jobs are currently waiting in PostgreSQL. Enqueue a job to begin processing.'}
                    </p>
                    {hasFilters && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={clearFilters}
                        className="mt-2 text-xs"
                      >
                        Reset All Filters
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              jobs.map((j) => {
                const priorityMeta = getPriorityMeta(j.priority);
                const cancellable = isJobCancellable(j.status);

                return (
                  <TableRow
                    key={j.id}
                    tabIndex={0}
                    role="button"
                    aria-label={`Inspect job ${j.id}`}
                    onClick={() => setSelectedJobId(j.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedJobId(j.id);
                      }
                    }}
                    className="border-border-subtle hover:bg-surface-canvas/60 focus-visible:ring-focus-ring cursor-pointer transition-colors focus-visible:ring-1 focus-visible:outline-hidden"
                  >
                    {/* Job ID & Queue */}
                    <TableCell>
                      <div className="flex items-center gap-1.5 font-mono">
                        <span className="text-text-primary text-[0.6875rem] font-medium">
                          {j.id}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopy(j.id, `row-id-${j.id}`);
                          }}
                          className="text-text-muted hover:text-text-primary p-0.5"
                          title="Copy Job ULID"
                        >
                          <HugeiconsIcon
                            icon={
                              copiedKey === `row-id-${j.id}`
                                ? Tick01Icon
                                : Copy01Icon
                            }
                            className={cn(
                              'h-3 w-3',
                              copiedKey === `row-id-${j.id}` &&
                                'text-status-success-text',
                            )}
                          />
                        </button>
                      </div>
                      <div
                        className="text-text-muted mt-0.5 flex items-center gap-1 text-[0.6875rem]"
                        onClick={(e) => {
                          e.stopPropagation();
                          updateFilter((sp) => {
                            sp.delete('queue');
                            sp.append('queue', j.queue);
                          });
                        }}
                      >
                        <span className="hover:text-text-primary hover:underline">
                          {j.queue}
                        </span>
                      </div>
                    </TableCell>

                    {/* Handler */}
                    <TableCell>
                      <span
                        className="text-text-primary font-mono text-[0.6875rem] hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          updateFilter((sp) => {
                            sp.delete('handler');
                            sp.append('handler', j.handler);
                          });
                        }}
                      >
                        {j.handler}
                      </span>
                    </TableCell>

                    {/* Status */}
                    <TableCell>
                      <StatusBadge status={j.status} />
                    </TableCell>

                    {/* Priority */}
                    <TableCell>
                      <Badge
                        tone={
                          priorityMeta.tone === 'high'
                            ? 'warning'
                            : priorityMeta.tone === 'low'
                              ? 'muted'
                              : 'neutral'
                        }
                      >
                        {priorityMeta.label}
                      </Badge>
                    </TableCell>

                    {/* Attempts */}
                    <TableCell className="text-right tabular-nums">
                      <span
                        className={cn(
                          'font-mono text-xs',
                          j.attempt > 1 && j.status !== 'succeeded'
                            ? 'text-status-warning-text font-semibold'
                            : 'text-text-primary',
                        )}
                      >
                        {formatAttemptRatio(j.attempt, j.maxAttempts)}
                      </span>
                    </TableCell>

                    {/* Enqueued Timestamp */}
                    <TableCell
                      className="text-text-muted font-mono text-xs tabular-nums"
                      title={formatDateTimeUTC(j.enqueuedAt)}
                    >
                      {formatClockUTC(j.enqueuedAt)}
                    </TableCell>

                    {/* Relative Age */}
                    <TableCell className="text-text-muted text-right font-mono text-xs tabular-nums">
                      {formatRelative(j.enqueuedAt)}
                    </TableCell>

                    {/* In-row Actions */}
                    <TableCell className="text-right">
                      <div
                        className="flex items-center justify-end gap-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {/* Quick Drawer Inspector */}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedJobId(j.id);
                          }}
                          className="text-text-muted hover:text-text-primary h-7 px-2 text-xs"
                          title="Open Quick Inspector Drawer"
                        >
                          <HugeiconsIcon
                            icon={ViewIcon}
                            className="h-3.5 w-3.5"
                          />
                          <span className="hidden sm:inline">Inspect</span>
                        </Button>

                        {/* Guarded Cancel Button */}
                        {cancellable && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              setCancellingJob(j);
                            }}
                            className="text-status-danger-text hover:bg-status-danger-bg h-7 px-2 text-xs"
                            title="Cancel Job"
                          >
                            <HugeiconsIcon
                              icon={Cancel01Icon}
                              className="h-3.5 w-3.5"
                            />
                            <span className="hidden sm:inline">Cancel</span>
                          </Button>
                        )}

                        {/* More Actions Dropdown */}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              aria-label="More job actions"
                            >
                              <HugeiconsIcon
                                icon={MoreHorizontalIcon}
                                className="h-4 w-4"
                              />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            className="w-48 text-xs"
                          >
                            <DropdownMenuLabel>Job Actions</DropdownMenuLabel>
                            <DropdownMenuItem
                              onClick={() =>
                                handleCopy(j.id, `menu-id-${j.id}`)
                              }
                            >
                              <HugeiconsIcon
                                icon={Copy01Icon}
                                className="h-3.5 w-3.5"
                              />
                              <span>Copy Job ID</span>
                            </DropdownMenuItem>

                            <DropdownMenuItem
                              onClick={() =>
                                handleCopy(
                                  JSON.stringify(j.payload, null, 2),
                                  `menu-payload-${j.id}`,
                                )
                              }
                            >
                              <HugeiconsIcon
                                icon={Copy01Icon}
                                className="h-3.5 w-3.5"
                              />
                              <span>Copy Payload JSON</span>
                            </DropdownMenuItem>

                            <DropdownMenuItem
                              onClick={() => setSelectedJobId(j.id)}
                            >
                              <HugeiconsIcon
                                icon={ViewIcon}
                                className="h-3.5 w-3.5"
                              />
                              <span>Inspect in Drawer</span>
                            </DropdownMenuItem>

                            <DropdownMenuItem
                              onClick={() => navigate(jobDetailPath(j.id))}
                            >
                              <HugeiconsIcon
                                icon={ArrowRight01Icon}
                                className="h-3.5 w-3.5"
                              />
                              <span>Open Full Page</span>
                            </DropdownMenuItem>

                            <DropdownMenuSeparator />

                            {cancellable && (
                              <DropdownMenuItem
                                onClick={() => setCancellingJob(j)}
                                className="text-status-danger-text focus:text-status-danger-text"
                              >
                                <HugeiconsIcon
                                  icon={Cancel01Icon}
                                  className="h-3.5 w-3.5"
                                />
                                <span>Cancel Job</span>
                              </DropdownMenuItem>
                            )}

                            {/* Disabled Future Actions with Explicit Pending Backend Reasons */}
                            <DropdownMenuItem
                              disabled
                              title="Backend capability pending: POST /jobs/:id/retry"
                              className="text-text-disabled cursor-not-allowed justify-between"
                            >
                              <span>Retry Job</span>
                              <span className="border-border-subtle bg-surface-elevated text-text-muted rounded px-1 py-0.5 text-[0.5625rem]">
                                API Pending
                              </span>
                            </DropdownMenuItem>

                            <DropdownMenuItem
                              disabled
                              title="Backend capability pending: PATCH /jobs/:id"
                              className="text-text-disabled cursor-not-allowed justify-between"
                            >
                              <span>Adjust Priority</span>
                              <span className="border-border-subtle bg-surface-elevated text-text-muted rounded px-1 py-0.5 text-[0.5625rem]">
                                API Pending
                              </span>
                            </DropdownMenuItem>

                            <DropdownMenuItem
                              disabled
                              title="Backend capability pending: DELETE /jobs/:id"
                              className="text-text-disabled cursor-not-allowed justify-between"
                            >
                              <span>Purge from DLQ</span>
                              <span className="border-border-subtle bg-surface-elevated text-text-muted rounded px-1 py-0.5 text-[0.5625rem]">
                                API Pending
                              </span>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination Footer */}
      <div className="flex flex-col gap-2 text-xs sm:flex-row sm:items-center sm:justify-between">
        <p className="text-text-muted">
          Page{' '}
          <span className="text-text-primary font-medium tabular-nums">
            {page + 1}
          </span>{' '}
          of{' '}
          <span className="text-text-primary font-medium tabular-nums">
            {Math.max(1, Math.ceil(total / PAGE_SIZE)).toLocaleString()}
          </span>{' '}
          ({PAGE_SIZE} items per page)
        </p>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => goToPage(page - 1)}
            disabled={!hasPrev || isFetching}
            className="text-xs"
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => goToPage(page + 1)}
            disabled={!hasNext || isFetching}
            className="text-xs"
          >
            Next
          </Button>
        </div>
      </div>

      {/* Live-Synced Quick Inspector Drawer */}
      <JobInspectorDrawer
        jobId={selectedJobId}
        open={Boolean(selectedJobId)}
        onOpenChange={(open) => {
          if (!open) setSelectedJobId(null);
        }}
        onCancelRequest={(job) => {
          setCancellingJob(job);
        }}
      />

      {/* Guarded Cancel Job Confirmation Dialog */}
      <JobCancelDialog
        job={cancellingJob}
        open={Boolean(cancellingJob)}
        onOpenChange={(open) => {
          if (!open) setCancellingJob(null);
        }}
        onSuccess={() => {
          refetch();
        }}
      />

      {/* Quick Enqueue Dialog */}
      <QuickEnqueueDialog
        open={isEnqueueOpen}
        onOpenChange={setIsEnqueueOpen}
        availableQueues={queueOptions}
        onSuccess={() => {
          refetch();
        }}
      />
    </div>
  );
}

function parseStatusParams(raw: string[]): JobStatus[] {
  const valid = new Set<JobStatus>(ALL_STATUSES);
  return raw.filter((s): s is JobStatus => valid.has(s as JobStatus));
}
