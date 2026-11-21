import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CodeBlock } from '@/components/ui/code-block';
import {
  Dialog,
  DialogClose,
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
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  useWorkers,
  useReleaseWorkerLease,
  useDrainWorker,
  useCordonWorker,
  useResumeWorker,
  useDeregisterWorker,
} from '@/hooks/api';
import { generateWorkerSnippet } from '@/lib/enqueue-helpers';
import { formatDateTimeUTC, formatRelative } from '@/lib/format';
import {
  jobDetailPath,
  jobsByHandlerPath,
  jobsByQueuePath,
  workerDetailPath,
} from '@/lib/routes';
import type { WorkerLease } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  computeFleetMetrics,
  extractAllQueues,
  filterAndSortWorkers,
  formatDurationMs,
  formatLeaseTimeRemaining,
  formatUptime,
  getHeartbeatOverdueDurationMs,
  getWorkerLifecycle,
  getWorkerStatusBadgeProps,
  isHeartbeatStale,
  type WorkerFilterTab,
  type WorkerSortOption,
} from '@/lib/workers-helpers';
import {
  Activity01Icon,
  Alert02Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Clock01Icon,
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
import { Link, useNavigate } from 'react-router-dom';

export function WorkersPage() {
  const navigate = useNavigate();
  const { data, isLoading, isFetching, isError, error, refetch } = useWorkers();
  const workers = useMemo(() => data?.workers ?? [], [data?.workers]);

  // Refinement 1: Store only selectedWorkerId in state so open drawer metrics,
  // heartbeat diagnostics, and active leases live-sync on SSE/poll refetches.
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const selectedWorker = useMemo(
    () => workers.find((w) => w.id === selectedWorkerId),
    [workers, selectedWorkerId],
  );

  // Search & Filter state
  const [filterTab, setFilterTab] = useState<WorkerFilterTab>('all');
  const [selectedQueue, setSelectedQueue] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sortBy, setSortBy] = useState<WorkerSortOption>('heartbeat_desc');

  // External worker SDK modal state
  const [showConnectModal, setShowConnectModal] = useState<boolean>(false);

  // Copy feedback state
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Lease force-release mutation & dialog target state
  const [releaseTarget, setReleaseTarget] = useState<{
    workerId: string;
    workerHostname: string;
    lease: WorkerLease;
  } | null>(null);

  // Worker lifecycle mutations & dialog states
  const [drainTarget, setDrainTarget] = useState<{
    workerId: string;
    hostname: string;
  } | null>(null);

  const [deregisterTarget, setDeregisterTarget] = useState<{
    workerId: string;
    hostname: string;
  } | null>(null);

  const drainMutation = useDrainWorker({
    onSuccess: () => {
      setDrainTarget(null);
    },
  });

  const cordonMutation = useCordonWorker();
  const resumeMutation = useResumeWorker();

  const deregisterMutation = useDeregisterWorker({
    onSuccess: () => {
      setDeregisterTarget(null);
    },
  });

  const releaseLeaseMutation = useReleaseWorkerLease({
    onSuccess: () => {
      setReleaseTarget(null);
    },
  });

  const handleConfirmRelease = () => {
    if (!releaseTarget) return;
    releaseLeaseMutation.mutate({
      workerId: releaseTarget.workerId,
      jobId: releaseTarget.lease.jobId,
    });
  };

  const handleCopy = useCallback((text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((curr) => (curr === key ? null : curr));
    }, 2000);
  }, []);

  // Compute fleet capacity & health metrics (Refinement 2: excludes disconnected from active capacity)
  const metrics = useMemo(() => computeFleetMetrics(workers), [workers]);

  // Extract all unique queues
  const allQueues = useMemo(() => extractAllQueues(workers), [workers]);

  // Filtered & sorted workers list
  const filteredWorkers = useMemo(
    () =>
      filterAndSortWorkers(workers, {
        tab: filterTab,
        queue: selectedQueue,
        query: searchQuery,
        sortBy,
      }),
    [workers, filterTab, selectedQueue, searchQuery, sortBy],
  );

  const hasActiveFilters =
    filterTab !== 'all' || selectedQueue !== 'all' || searchQuery.trim() !== '';

  const handleResetFilters = () => {
    setFilterTab('all');
    setSelectedQueue('all');
    setSearchQuery('');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-text-primary text-base font-semibold tracking-tight">
            Workers
          </h2>
          <p className="text-text-muted text-xs">
            {isLoading ? (
              'Loading fleet roster…'
            ) : (
              <>
                <span className="text-text-primary font-medium tabular-nums">
                  {metrics.totalWorkers}
                </span>{' '}
                worker{metrics.totalWorkers === 1 ? '' : 's'} registered ·{' '}
                <span className="text-text-primary font-medium tabular-nums">
                  {metrics.activeFleetWorkers}
                </span>{' '}
                active in fleet
              </>
            )}
            {isFetching && !isLoading && (
              <span className="text-text-muted/60 ml-1.5 inline-flex items-center gap-1">
                <span className="bg-status-info-solid inline-block h-1.5 w-1.5 animate-pulse rounded-full" />
                refreshing…
              </span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowConnectModal(true)}
            className="text-xs"
            title="Connect an external TypeScript / Node.js worker via SDK"
          >
            <HugeiconsIcon icon={ServerStack01Icon} className="h-3.5 w-3.5" />
            <span>Connect External Worker</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            className="text-xs"
            title="Force refresh worker fleet"
          >
            <HugeiconsIcon
              icon={Refresh01Icon}
              className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')}
            />
            Refresh
          </Button>
        </div>
      </div>
      {isError && (
        <div
          role="alert"
          className="border-status-danger-border bg-status-danger-bg text-status-danger-text flex items-center justify-between rounded-md border px-3.5 py-2.5 text-xs"
        >
          <div className="flex items-center gap-2">
            <HugeiconsIcon icon={Alert02Icon} className="h-4 w-4 shrink-0" />
            <span>
              Failed to load worker fleet:{' '}
              {error?.message ?? 'Internal server error'}
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
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Card className="border-border-subtle bg-surface-base">
          <CardHeader className="p-3 pb-1">
            <CardTitle className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
              Total Fleet
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div className="text-text-primary text-xl font-semibold tracking-tight tabular-nums">
              {metrics.totalWorkers}
            </div>
            <div className="text-text-muted mt-0.5 text-[0.6875rem] tabular-nums">
              {metrics.activeFleetWorkers} active nodes
            </div>
          </CardContent>
        </Card>
        <Card className="border-border-subtle bg-surface-base">
          <CardHeader className="p-3 pb-1">
            <CardTitle className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
              Busy / Leased
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div className="text-status-success-text text-xl font-semibold tracking-tight tabular-nums">
              {metrics.busyWorkers}
            </div>
            <div className="text-text-muted mt-0.5 text-[0.6875rem] tabular-nums">
              {metrics.totalInFlight} in-flight execution
              {metrics.totalInFlight === 1 ? '' : 's'}
            </div>
          </CardContent>
        </Card>
        <Card className="border-border-subtle bg-surface-base">
          <CardHeader className="p-3 pb-1">
            <CardTitle className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
              Idle Nodes
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div className="text-text-primary text-xl font-semibold tracking-tight tabular-nums">
              {metrics.idleWorkers}
            </div>
            <div className="text-text-muted mt-0.5 text-[0.6875rem]">
              Ready for queue work
            </div>
          </CardContent>
        </Card>
        <Card className="border-border-subtle bg-surface-base">
          <CardHeader className="p-3 pb-1">
            <CardTitle className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
              Stale / Degraded
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div
              className={cn(
                'text-xl font-semibold tracking-tight tabular-nums',
                metrics.staleWorkers > 0
                  ? 'text-status-warning-text'
                  : 'text-text-primary',
              )}
            >
              {metrics.staleWorkers}
            </div>
            <div className="text-text-muted mt-0.5 text-[0.6875rem]">
              {metrics.staleWorkers > 0
                ? 'Heartbeat overdue (>3× interval)'
                : 'All heartbeats healthy'}
            </div>
          </CardContent>
        </Card>
        <Card className="border-border-subtle bg-surface-base col-span-2 sm:col-span-1">
          <CardHeader className="p-3 pb-1">
            <CardTitle className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
              Fleet Capacity
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div className="text-text-primary text-xl font-semibold tracking-tight tabular-nums">
              {metrics.utilizationPct}%
            </div>
            <div className="text-text-muted mt-0.5 text-[0.6875rem] tabular-nums">
              {metrics.totalInFlight} / {metrics.totalCapacity} slots leased
            </div>
            <div className="bg-surface-elevated mt-1.5 h-1.5 w-full overflow-hidden rounded-full">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-300',
                  metrics.utilizationPct > 85
                    ? 'bg-status-warning-solid'
                    : 'bg-status-success-solid',
                )}
                style={{ width: `${Math.min(100, metrics.utilizationPct)}%` }}
              />
            </div>
          </CardContent>
        </Card>
      </div>
      <div className="space-y-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="border-border-subtle bg-surface-canvas flex flex-wrap gap-1 rounded-md border p-0.5">
            <button
              type="button"
              onClick={() => setFilterTab('all')}
              className={cn(
                'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                filterTab === 'all'
                  ? 'bg-surface-base text-text-primary shadow-xs'
                  : 'text-text-muted hover:text-text-primary',
              )}
            >
              All{' '}
              <span className="text-[0.625rem] tabular-nums opacity-75">
                ({metrics.totalWorkers})
              </span>
            </button>
            <button
              type="button"
              onClick={() => setFilterTab('busy')}
              className={cn(
                'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                filterTab === 'busy'
                  ? 'bg-surface-base text-status-success-text shadow-xs'
                  : 'text-text-muted hover:text-text-primary',
              )}
            >
              Busy{' '}
              <span className="text-[0.625rem] tabular-nums opacity-75">
                ({metrics.busyWorkers})
              </span>
            </button>
            <button
              type="button"
              onClick={() => setFilterTab('idle')}
              className={cn(
                'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                filterTab === 'idle'
                  ? 'bg-surface-base text-text-primary shadow-xs'
                  : 'text-text-muted hover:text-text-primary',
              )}
            >
              Idle{' '}
              <span className="text-[0.625rem] tabular-nums opacity-75">
                ({metrics.idleWorkers})
              </span>
            </button>
            <button
              type="button"
              onClick={() => setFilterTab('stale')}
              className={cn(
                'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                filterTab === 'stale'
                  ? 'bg-surface-base text-status-warning-text shadow-xs'
                  : 'text-text-muted hover:text-text-primary',
              )}
            >
              Stale / Degraded{' '}
              <span className="text-[0.625rem] tabular-nums opacity-75">
                ({metrics.staleWorkers})
              </span>
            </button>
            <button
              type="button"
              onClick={() => setFilterTab('disconnected')}
              className={cn(
                'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                filterTab === 'disconnected'
                  ? 'bg-surface-base text-status-danger-text shadow-xs'
                  : 'text-text-muted hover:text-text-primary',
              )}
            >
              Disconnected{' '}
              <span className="text-[0.625rem] tabular-nums opacity-75">
                ({metrics.disconnectedWorkers})
              </span>
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1 sm:w-64 sm:flex-none">
              <HugeiconsIcon
                icon={Search01Icon}
                className="text-text-muted absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2"
              />
              <Input
                type="text"
                placeholder="Search host, ID, PID, version…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-surface-base border-border-subtle h-8 pr-7 pl-8 text-xs"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="text-text-muted hover:text-text-primary absolute top-1/2 right-2 -translate-y-1/2"
                  title="Clear search"
                >
                  <HugeiconsIcon icon={Cancel01Icon} className="h-3 w-3" />
                </button>
              )}
            </div>
            <select
              aria-label="Filter workers by queue"
              value={selectedQueue}
              onChange={(e) => setSelectedQueue(e.target.value)}
              className="border-border-subtle bg-surface-base text-text-primary focus:border-border-strong h-8 rounded-md border px-2 text-xs focus:outline-hidden"
            >
              <option value="all">All Queues ({allQueues.length})</option>
              {allQueues.map((q) => (
                <option key={q} value={q}>
                  Queue: {q}
                </option>
              ))}
            </select>
            <select
              aria-label="Sort workers"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as WorkerSortOption)}
              className="border-border-subtle bg-surface-base text-text-primary focus:border-border-strong h-8 rounded-md border px-2 text-xs focus:outline-hidden"
            >
              <option value="heartbeat_desc">Heartbeat (Most Recent)</option>
              <option value="heartbeat_asc">Heartbeat (Oldest)</option>
              <option value="utilization_desc">Capacity Utilization</option>
              <option value="processed_desc">Total Processed</option>
              <option value="hostname_asc">Hostname (A-Z)</option>
            </select>
            {hasActiveFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleResetFilters}
                className="text-text-muted hover:text-text-primary h-8 px-2 text-xs"
              >
                Reset
              </Button>
            )}
          </div>
        </div>
      </div>
      <div className="border-border-subtle bg-surface-base overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow className="border-border-subtle bg-surface-canvas/60 hover:bg-surface-canvas/60">
              <TableHead className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
                Worker & Host
              </TableHead>
              <TableHead className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
                Worker ID
              </TableHead>
              <TableHead className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
                Status & Heartbeat
              </TableHead>
              <TableHead className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
                Subscribed Queues
              </TableHead>
              <TableHead className="text-text-muted text-right text-[0.6875rem] font-medium tracking-wider uppercase">
                In Flight / Max
              </TableHead>
              <TableHead className="text-text-muted text-right text-[0.6875rem] font-medium tracking-wider uppercase">
                Processed
              </TableHead>
              <TableHead className="text-text-muted text-right text-[0.6875rem] font-medium tracking-wider uppercase">
                Heartbeat Cadence
              </TableHead>
              <TableHead className="text-text-muted text-right text-[0.6875rem] font-medium tracking-wider uppercase">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              // Skeleton Loading Rows
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow
                  key={`skeleton-${i}`}
                  className="border-border-subtle"
                >
                  <TableCell>
                    <div className="bg-surface-elevated h-3.5 w-36 animate-pulse rounded" />
                    <div className="bg-surface-elevated mt-1.5 h-2.5 w-20 animate-pulse rounded" />
                  </TableCell>
                  <TableCell>
                    <div className="bg-surface-elevated h-3 w-16 animate-pulse rounded" />
                  </TableCell>
                  <TableCell>
                    <div className="bg-surface-elevated h-4 w-20 animate-pulse rounded" />
                  </TableCell>
                  <TableCell>
                    <div className="bg-surface-elevated h-3.5 w-28 animate-pulse rounded" />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="bg-surface-elevated ml-auto h-3.5 w-12 animate-pulse rounded" />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="bg-surface-elevated ml-auto h-3.5 w-14 animate-pulse rounded" />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="bg-surface-elevated ml-auto h-3.5 w-16 animate-pulse rounded" />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="bg-surface-elevated ml-auto h-6 w-12 animate-pulse rounded" />
                  </TableCell>
                </TableRow>
              ))
            ) : filteredWorkers.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="text-text-muted py-12 text-center text-xs"
                >
                  {workers.length === 0 ? (
                    <div className="space-y-1.5">
                      <p className="text-text-primary font-medium">
                        No workers registered in fleet.
                      </p>
                      <p className="text-text-muted text-[0.6875rem]">
                        Start a worker process via{' '}
                        <code className="bg-surface-elevated rounded px-1 py-0.5 font-mono">
                          go run ./apps/worker/cmd/worker
                        </code>{' '}
                        to connect.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-text-primary font-medium">
                        No workers match the selected filters.
                      </p>
                      <p className="text-text-muted text-[0.6875rem]">
                        Try clearing search terms or selecting another status
                        tab.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleResetFilters}
                        className="mt-1 text-xs"
                      >
                        Reset filters
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ) : (
              filteredWorkers.map((w) => {
                const lifecycle = getWorkerLifecycle(w);
                const badgeProps = getWorkerStatusBadgeProps(lifecycle);
                const stale = isHeartbeatStale(
                  w.lastHeartbeatAt,
                  w.heartbeatIntervalSeconds,
                );
                const overdueMs = getHeartbeatOverdueDurationMs(
                  w.lastHeartbeatAt,
                  w.heartbeatIntervalSeconds,
                );
                const utilPct =
                  w.maxConcurrency > 0
                    ? Math.min(
                        100,
                        Math.round((w.inFlight / w.maxConcurrency) * 100),
                      )
                    : 0;

                return (
                  <TableRow
                    key={w.id}
                    className="border-border-subtle hover:bg-surface-elevated/60 group cursor-pointer transition-colors"
                    onClick={() => setSelectedWorkerId(w.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedWorkerId(w.id);
                      }
                    }}
                    tabIndex={0}
                    role="button"
                    aria-label={`Inspect worker ${w.hostname}`}
                  >
                    <TableCell className="py-2.5">
                      <div className="flex flex-col">
                        <div className="flex items-center gap-1.5">
                          <span className="text-text-primary font-mono text-xs font-medium">
                            {w.hostname}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              // Refinement 3: Event isolation
                              e.stopPropagation();
                              handleCopy(w.hostname, `host-${w.id}`);
                            }}
                            className="text-text-muted hover:text-text-primary p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                            title="Copy hostname"
                            aria-label="Copy hostname"
                          >
                            <HugeiconsIcon
                              icon={
                                copiedKey === `host-${w.id}`
                                  ? Tick01Icon
                                  : Copy01Icon
                              }
                              className={cn(
                                'h-3 w-3',
                                copiedKey === `host-${w.id}` &&
                                  'text-status-success-text',
                              )}
                            />
                          </button>
                        </div>
                        <div className="text-text-muted mt-0.5 flex items-center gap-1.5 font-mono text-[0.625rem]">
                          <span>PID {w.pid}</span>
                          <span>·</span>
                          <span>{w.version}</span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="py-2.5">
                      <div className="flex items-center gap-1.5">
                        <span
                          className="text-text-muted font-mono text-[0.6875rem]"
                          title={w.id}
                        >
                          …{w.id.slice(-8)}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            // Refinement 3: Event isolation
                            e.stopPropagation();
                            handleCopy(w.id, `id-${w.id}`);
                          }}
                          className="text-text-muted hover:text-text-primary p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                          title="Copy full Worker ULID"
                          aria-label="Copy full Worker ULID"
                        >
                          <HugeiconsIcon
                            icon={
                              copiedKey === `id-${w.id}`
                                ? Tick01Icon
                                : Copy01Icon
                            }
                            className={cn(
                              'h-3 w-3',
                              copiedKey === `id-${w.id}` &&
                                'text-status-success-text',
                            )}
                          />
                        </button>
                      </div>
                    </TableCell>
                    <TableCell className="py-2.5">
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-1.5">
                          <Badge tone={badgeProps.tone}>
                            <span
                              className={cn(
                                'mr-1.5 inline-block h-1.5 w-1.5 rounded-full',
                                badgeProps.dotColorClass,
                              )}
                            />
                            {badgeProps.label}
                          </Badge>
                        </div>
                        {stale && w.state !== 'disconnected' && (
                          <span
                            className="text-status-warning-text text-[0.625rem] font-medium"
                            title="Heartbeat older than 3× interval — worker may have died without deregistering."
                          >
                            overdue by {formatDurationMs(overdueMs)}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {w.queues.map((q) => (
                          <button
                            key={q}
                            type="button"
                            onClick={(e) => {
                              // Refinement 3: Event isolation
                              e.stopPropagation();
                              setSelectedQueue(q);
                            }}
                            className="border-border-subtle bg-surface-canvas text-text-secondary hover:border-border-strong rounded px-1.5 py-0.5 font-mono text-[0.625rem] transition-colors"
                            title={`Filter table by queue: ${q}`}
                          >
                            {q}
                          </button>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="py-2.5 text-right tabular-nums">
                      <div className="flex items-center justify-end gap-2">
                        <div className="text-right">
                          <span className="text-text-primary font-medium">
                            {w.inFlight}
                          </span>
                          <span className="text-text-muted">
                            {' / '}
                            {w.maxConcurrency}
                          </span>
                          <span className="text-text-muted ml-1 text-[0.625rem]">
                            ({utilPct}%)
                          </span>
                        </div>
                        <div className="bg-surface-elevated h-1 w-12 overflow-hidden rounded-full">
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
                      </div>
                    </TableCell>
                    <TableCell className="text-text-primary py-2.5 text-right font-mono text-xs tabular-nums">
                      {w.totalProcessed.toLocaleString()}
                    </TableCell>
                    <TableCell className="py-2.5 text-right">
                      <div className="flex flex-col items-end">
                        <span
                          className="text-text-primary text-xs tabular-nums"
                          title={`Last heartbeat: ${formatDateTimeUTC(w.lastHeartbeatAt)}`}
                        >
                          {formatRelative(w.lastHeartbeatAt)}
                        </span>
                        <span className="text-text-muted text-[0.625rem]">
                          every {w.heartbeatIntervalSeconds}s
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="py-2.5 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={(e) => {
                            // Refinement 3: Event isolation
                            e.stopPropagation();
                            setSelectedWorkerId(w.id);
                          }}
                          title="Quick inspect active leases and heartbeat diagnostics"
                        >
                          <HugeiconsIcon
                            icon={ViewIcon}
                            className="h-3.5 w-3.5"
                          />
                          Inspect
                        </Button>

                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              onClick={(e) => {
                                // Refinement 3: Event isolation
                                e.stopPropagation();
                              }}
                              aria-label={`Actions for worker ${w.hostname}`}
                            >
                              <HugeiconsIcon
                                icon={MoreHorizontalIcon}
                                className="h-3.5 w-3.5"
                              />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            className="w-56"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <DropdownMenuLabel className="text-text-muted text-[0.6875rem] font-medium">
                              Worker Actions
                            </DropdownMenuLabel>
                            <DropdownMenuItem
                              onSelect={() => setSelectedWorkerId(w.id)}
                            >
                              <HugeiconsIcon
                                icon={ViewIcon}
                                className="mr-2 h-3.5 w-3.5"
                              />
                              Quick Inspect
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => navigate(workerDetailPath(w.id))}
                            >
                              <HugeiconsIcon
                                icon={ArrowRight01Icon}
                                className="mr-2 h-3.5 w-3.5"
                              />
                              View Full Details Page
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => handleCopy(w.id, `id-${w.id}`)}
                            >
                              <HugeiconsIcon
                                icon={Copy01Icon}
                                className="mr-2 h-3.5 w-3.5"
                              />
                              Copy Worker ID
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() =>
                                handleCopy(w.hostname, `host-${w.id}`)
                              }
                            >
                              <HugeiconsIcon
                                icon={Copy01Icon}
                                className="mr-2 h-3.5 w-3.5"
                              />
                              Copy Hostname
                            </DropdownMenuItem>

                            <DropdownMenuSeparator />
                            <DropdownMenuLabel className="text-text-muted text-[0.625rem] font-medium tracking-wider uppercase">
                              Fleet Operations
                            </DropdownMenuLabel>

                            <DropdownMenuItem
                              disabled={
                                w.state === 'disconnected' ||
                                w.state === 'draining' ||
                                drainMutation.isPending
                              }
                              title={
                                w.state === 'disconnected'
                                  ? 'Worker is already disconnected'
                                  : w.state === 'draining'
                                    ? 'Worker is already draining'
                                    : 'Drain worker: finish active leases then stop'
                              }
                              onClick={() =>
                                setDrainTarget({
                                  workerId: w.id,
                                  hostname: w.hostname,
                                })
                              }
                              className={cn(
                                'justify-between',
                                w.state === 'disconnected' ||
                                  w.state === 'draining'
                                  ? 'text-text-disabled cursor-not-allowed'
                                  : 'text-text-primary hover:text-text-primary',
                              )}
                            >
                              <span>Drain Worker</span>
                              {w.state === 'draining' && (
                                <span className="border-status-info-border/60 bg-status-info-bg text-status-info-text rounded px-1 py-0.5 text-[0.5625rem]">
                                  Draining
                                </span>
                              )}
                            </DropdownMenuItem>

                            {w.state === 'cordoned' ? (
                              <DropdownMenuItem
                                disabled={resumeMutation.isPending}
                                onClick={() => resumeMutation.mutate(w.id)}
                                className="text-status-success-text hover:text-status-success-text justify-between"
                              >
                                <span>Resume Worker</span>
                                <span className="border-status-success-border/60 bg-status-success-bg text-status-success-text rounded px-1 py-0.5 text-[0.5625rem]">
                                  Cordoned
                                </span>
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                disabled={
                                  w.state === 'disconnected' ||
                                  cordonMutation.isPending
                                }
                                title={
                                  w.state === 'disconnected'
                                    ? 'Worker is disconnected'
                                    : 'Pause worker from claiming new jobs'
                                }
                                onClick={() => cordonMutation.mutate(w.id)}
                                className={cn(
                                  'justify-between',
                                  w.state === 'disconnected'
                                    ? 'text-text-disabled cursor-not-allowed'
                                    : 'text-status-warning-text hover:text-status-warning-text',
                                )}
                              >
                                <span>Cordon / Pause</span>
                              </DropdownMenuItem>
                            )}

                            {w.leases.length === 0 ? (
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
                            ) : (
                              <DropdownMenuItem
                                onClick={() => setSelectedWorkerId(w.id)}
                                className="text-status-warning-text hover:text-status-warning-text justify-between"
                              >
                                <span>Release Leases ({w.leases.length})</span>
                                <span className="border-border-subtle bg-surface-elevated text-text-muted rounded px-1 py-0.5 text-[0.5625rem]">
                                  Inspect
                                </span>
                              </DropdownMenuItem>
                            )}

                            <DropdownMenuItem
                              disabled={
                                w.inFlight > 0 || deregisterMutation.isPending
                              }
                              title={
                                w.inFlight > 0
                                  ? `Cannot deregister worker with active leases (${w.inFlight} active)`
                                  : 'Permanently remove worker record'
                              }
                              onClick={() =>
                                setDeregisterTarget({
                                  workerId: w.id,
                                  hostname: w.hostname,
                                })
                              }
                              className={cn(
                                'justify-between',
                                w.inFlight > 0
                                  ? 'text-text-disabled cursor-not-allowed'
                                  : 'text-status-danger-text hover:text-status-danger-text',
                              )}
                            >
                              <span>Deregister Worker</span>
                              {w.inFlight > 0 && (
                                <span className="border-border-subtle bg-surface-elevated text-text-muted rounded px-1 py-0.5 text-[0.5625rem]">
                                  {w.inFlight} Active
                                </span>
                              )}
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
      <Dialog
        open={!!selectedWorkerId}
        onOpenChange={(open) => {
          if (!open) setSelectedWorkerId(null);
        }}
      >
        <DialogContent className="border-border-strong bg-surface-base max-h-[88vh] gap-0 overflow-hidden p-0 sm:max-w-3xl">
          {selectedWorker ? (
            <div className="flex max-h-[88vh] flex-col">
              <div className="border-border-subtle bg-surface-canvas/60 flex items-center justify-between border-b px-6 py-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <DialogTitle className="text-text-primary font-mono text-sm font-semibold">
                      {selectedWorker.hostname}
                    </DialogTitle>
                    <Badge
                      tone={
                        getWorkerStatusBadgeProps(
                          getWorkerLifecycle(selectedWorker),
                        ).tone
                      }
                    >
                      {
                        getWorkerStatusBadgeProps(
                          getWorkerLifecycle(selectedWorker),
                        ).label
                      }
                    </Badge>
                  </div>
                  <DialogDescription className="text-text-muted flex items-center gap-2 font-mono text-xs">
                    <span>ID: {selectedWorker.id}</span>
                    <button
                      type="button"
                      onClick={() =>
                        handleCopy(
                          selectedWorker.id,
                          `drawer-id-${selectedWorker.id}`,
                        )
                      }
                      className="text-text-muted hover:text-text-primary p-0.5"
                      title="Copy Worker ULID"
                    >
                      <HugeiconsIcon
                        icon={
                          copiedKey === `drawer-id-${selectedWorker.id}`
                            ? Tick01Icon
                            : Copy01Icon
                        }
                        className={cn(
                          'h-3 w-3',
                          copiedKey === `drawer-id-${selectedWorker.id}` &&
                            'text-status-success-text',
                        )}
                      />
                    </button>
                    <span>·</span>
                    <span>PID: {selectedWorker.pid}</span>
                    <span>·</span>
                    <span>{selectedWorker.version}</span>
                  </DialogDescription>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    asChild
                    variant="outline"
                    size="sm"
                    className="text-xs"
                  >
                    <Link to={workerDetailPath(selectedWorker.id)}>
                      <span>Full Page</span>
                      <HugeiconsIcon
                        icon={ArrowRight01Icon}
                        className="ml-1.5 h-3.5 w-3.5"
                      />
                    </Link>
                  </Button>
                  <DialogClose asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0"
                      aria-label="Close inspector"
                    >
                      <HugeiconsIcon icon={Cancel01Icon} className="h-4 w-4" />
                    </Button>
                  </DialogClose>
                </div>
              </div>
              <div className="flex-1 space-y-6 overflow-y-auto p-6 text-xs">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="border-border-subtle bg-surface-canvas/40 space-y-2 rounded-md border p-3.5">
                    <div className="text-text-muted flex items-center gap-1.5 text-[0.6875rem] font-medium tracking-wider uppercase">
                      <HugeiconsIcon
                        icon={Activity01Icon}
                        className="h-3.5 w-3.5"
                      />
                      Runtime & Uptime
                    </div>
                    <div className="space-y-1.5 pt-1">
                      <div className="flex justify-between">
                        <span className="text-text-muted">Started At:</span>
                        <span className="text-text-primary font-mono tabular-nums">
                          {formatDateTimeUTC(selectedWorker.startedAt)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-text-muted">Uptime:</span>
                        <span className="text-text-primary font-mono tabular-nums">
                          {formatUptime(selectedWorker.startedAt)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-text-muted">
                          Total Processed:
                        </span>
                        <span className="text-text-primary font-mono tabular-nums">
                          {selectedWorker.totalProcessed.toLocaleString()} jobs
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="border-border-subtle bg-surface-canvas/40 space-y-2 rounded-md border p-3.5">
                    <div className="text-text-muted flex items-center gap-1.5 text-[0.6875rem] font-medium tracking-wider uppercase">
                      <HugeiconsIcon
                        icon={Clock01Icon}
                        className="h-3.5 w-3.5"
                      />
                      Heartbeat Diagnostics
                    </div>
                    <div className="space-y-1.5 pt-1">
                      <div className="flex justify-between">
                        <span className="text-text-muted">Last Received:</span>
                        <span
                          className="text-text-primary font-mono tabular-nums"
                          title={formatDateTimeUTC(
                            selectedWorker.lastHeartbeatAt,
                          )}
                        >
                          {formatRelative(selectedWorker.lastHeartbeatAt)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-text-muted">
                          Cadence Interval:
                        </span>
                        <span className="text-text-primary font-mono tabular-nums">
                          every {selectedWorker.heartbeatIntervalSeconds}s
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-text-muted">
                          Sweeper Timeout:
                        </span>
                        <span className="text-text-primary font-mono tabular-nums">
                          {selectedWorker.heartbeatIntervalSeconds * 3}s (3×
                          interval)
                        </span>
                      </div>
                      {isHeartbeatStale(
                        selectedWorker.lastHeartbeatAt,
                        selectedWorker.heartbeatIntervalSeconds,
                      ) && (
                        <div className="text-status-warning-text flex justify-between font-medium">
                          <span>Overdue Past Threshold:</span>
                          <span className="font-mono tabular-nums">
                            +
                            {formatDurationMs(
                              getHeartbeatOverdueDurationMs(
                                selectedWorker.lastHeartbeatAt,
                                selectedWorker.heartbeatIntervalSeconds,
                              ),
                            )}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <div className="space-y-3">
                  <div>
                    <h4 className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
                      Subscribed Queues ({selectedWorker.queues.length})
                    </h4>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {selectedWorker.queues.map((q) => (
                        <Link
                          key={q}
                          to={jobsByQueuePath(q)}
                          className="border-border-subtle bg-surface-elevated text-text-secondary hover:border-border-strong rounded px-2 py-1 font-mono text-xs transition-colors"
                          title={`View jobs in queue ${q}`}
                        >
                          {q}
                        </Link>
                      ))}
                    </div>
                  </div>

                  <div>
                    <h4 className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
                      Registered Handlers ({selectedWorker.handlers.length})
                    </h4>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {selectedWorker.handlers.map((h) => (
                        <Link
                          key={h}
                          to={jobsByHandlerPath(h)}
                          className="border-border-subtle bg-surface-elevated text-text-secondary hover:border-border-strong rounded px-2 py-1 font-mono text-xs transition-colors"
                          title={`View jobs handled by ${h}`}
                        >
                          {h}
                        </Link>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h4 className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
                      Active Running Leases ({selectedWorker.leases.length} /{' '}
                      {selectedWorker.maxConcurrency} slots)
                    </h4>
                    {selectedWorker.leases.length > 0 && (
                      <span className="text-text-muted text-[0.6875rem] tabular-nums">
                        {Math.round(
                          (selectedWorker.leases.length /
                            selectedWorker.maxConcurrency) *
                            100,
                        )}
                        % utilized
                      </span>
                    )}
                  </div>

                  {selectedWorker.leases.length === 0 ? (
                    <div className="border-border-subtle bg-surface-canvas/40 rounded-md border p-4 text-center">
                      <p className="text-text-muted text-xs">
                        Worker is idle with 0 in-flight leases.
                      </p>
                    </div>
                  ) : (
                    <div className="border-border-subtle overflow-hidden rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow className="border-border-subtle bg-surface-canvas/60">
                            <TableHead className="text-text-muted text-[0.6875rem] font-medium uppercase">
                              Job ID
                            </TableHead>
                            <TableHead className="text-text-muted text-[0.6875rem] font-medium uppercase">
                              Handler
                            </TableHead>
                            <TableHead className="text-text-muted text-[0.6875rem] font-medium uppercase">
                              Queue
                            </TableHead>
                            <TableHead className="text-text-muted text-right text-[0.6875rem] font-medium uppercase">
                              Attempt
                            </TableHead>
                            <TableHead className="text-text-muted text-right text-[0.6875rem] font-medium uppercase">
                              Lease Remaining TTL
                            </TableHead>
                            <TableHead className="text-text-muted text-right text-[0.6875rem] font-medium uppercase">
                              Action
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {selectedWorker.leases.map((lease) => {
                            const ttl = formatLeaseTimeRemaining(
                              lease.leaseExpiresAt,
                            );
                            return (
                              <TableRow
                                key={lease.jobId}
                                className="border-border-subtle hover:bg-surface-elevated/40"
                              >
                                <TableCell className="py-2">
                                  <div className="flex items-center gap-1.5">
                                    <Link
                                      to={jobDetailPath(lease.jobId)}
                                      className="text-text-primary hover:text-text-primary font-mono text-xs underline underline-offset-2"
                                    >
                                      {lease.jobId}
                                    </Link>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        handleCopy(
                                          lease.jobId,
                                          `lease-job-${lease.jobId}`,
                                        )
                                      }
                                      className="text-text-muted hover:text-text-primary p-0.5"
                                      title="Copy Job ID"
                                    >
                                      <HugeiconsIcon
                                        icon={
                                          copiedKey ===
                                          `lease-job-${lease.jobId}`
                                            ? Tick01Icon
                                            : Copy01Icon
                                        }
                                        className={cn(
                                          'h-3 w-3',
                                          copiedKey ===
                                            `lease-job-${lease.jobId}` &&
                                            'text-status-success-text',
                                        )}
                                      />
                                    </button>
                                  </div>
                                </TableCell>
                                <TableCell className="text-text-muted py-2 font-mono text-xs">
                                  {lease.handler}
                                </TableCell>
                                <TableCell className="text-text-muted py-2 font-mono text-xs">
                                  {lease.queue}
                                </TableCell>
                                <TableCell className="text-text-muted py-2 text-right font-mono text-xs tabular-nums">
                                  #{lease.attempt}
                                </TableCell>
                                <TableCell className="py-2 text-right font-mono text-xs tabular-nums">
                                  <span
                                    className={cn(
                                      ttl.expired
                                        ? 'text-status-danger-text font-medium'
                                        : ttl.remainingMs < 5000
                                          ? 'text-status-warning-text'
                                          : 'text-text-primary',
                                    )}
                                    title={`Expires at: ${formatDateTimeUTC(lease.leaseExpiresAt)}`}
                                  >
                                    {ttl.label}
                                  </span>
                                </TableCell>
                                <TableCell className="py-2 text-right">
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() =>
                                      setReleaseTarget({
                                        workerId: selectedWorker.id,
                                        workerHostname: selectedWorker.hostname,
                                        lease,
                                      })
                                    }
                                    className="border-status-danger-border/60 text-status-danger-text hover:bg-status-danger-bg hover:border-status-danger-border h-6 px-2 text-[0.6875rem] transition-colors"
                                    title={`Force-release lease for job ${lease.jobId}`}
                                  >
                                    Release
                                  </Button>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              </div>
              <div className="border-border-subtle bg-surface-canvas/60 flex items-center justify-between border-t px-6 py-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    handleCopy(
                      JSON.stringify(selectedWorker, null, 2),
                      `worker-json-${selectedWorker.id}`,
                    )
                  }
                  className="text-xs"
                >
                  <HugeiconsIcon
                    icon={
                      copiedKey === `worker-json-${selectedWorker.id}`
                        ? Tick01Icon
                        : Copy01Icon
                    }
                    className="mr-1.5 h-3.5 w-3.5"
                  />
                  {copiedKey === `worker-json-${selectedWorker.id}`
                    ? 'Copied Diagnostics JSON'
                    : 'Copy Diagnostics JSON'}
                </Button>

                <DialogClose asChild>
                  <Button variant="secondary" size="sm" className="text-xs">
                    Close
                  </Button>
                </DialogClose>
              </div>
            </div>
          ) : (
            <div className="p-8 text-center">
              <p className="text-text-muted text-xs">
                Worker record no longer found in current fleet.
              </p>
              <DialogClose asChild>
                <Button variant="outline" size="sm" className="mt-3 text-xs">
                  Close
                </Button>
              </DialogClose>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!releaseTarget}
        onOpenChange={(open) => {
          if (!open && !releaseLeaseMutation.isPending) {
            setReleaseTarget(null);
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
                {releaseTarget?.workerHostname}
              </span>
              ?
            </DialogDescription>
          </DialogHeader>

          {releaseTarget && (
            <div className="space-y-3">
              <div className="border-border-subtle bg-surface-canvas/50 space-y-2 rounded-md border p-3 text-xs">
                <div className="flex justify-between">
                  <span className="text-text-muted">Job ID:</span>
                  <span className="text-text-primary font-mono font-medium">
                    {releaseTarget.lease.jobId}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">Handler:</span>
                  <span className="text-text-primary font-mono">
                    {releaseTarget.lease.handler}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">Queue:</span>
                  <span className="text-text-primary font-mono">
                    {releaseTarget.lease.queue}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">Attempt:</span>
                  <span className="text-text-primary font-mono">
                    #{releaseTarget.lease.attempt}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">Worker ID:</span>
                  <span
                    className="text-text-muted max-w-[200px] truncate font-mono"
                    title={releaseTarget.workerId}
                  >
                    {releaseTarget.workerId}
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
              onClick={() => setReleaseTarget(null)}
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
      <Dialog
        open={!!drainTarget}
        onOpenChange={(open) => {
          if (!open && !drainMutation.isPending) {
            setDrainTarget(null);
          }
        }}
      >
        <DialogContent className="border-border-strong bg-surface-base sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Drain Worker</DialogTitle>
            <DialogDescription>
              Drain worker{' '}
              <span className="text-text-primary font-mono font-medium">
                {drainTarget?.hostname}
              </span>
              ? The worker will cease claiming new jobs from all queues while
              completing its current in-flight executions.
            </DialogDescription>
          </DialogHeader>

          {drainMutation.isError && (
            <div
              role="alert"
              className="border-status-danger-border bg-status-danger-bg text-status-danger-text rounded-md border p-2.5 text-xs"
            >
              {drainMutation.error?.message ?? 'Failed to drain worker'}
            </div>
          )}

          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDrainTarget(null)}
              disabled={drainMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => {
                if (drainTarget) {
                  drainMutation.mutate(drainTarget.workerId);
                }
              }}
              disabled={drainMutation.isPending}
            >
              {drainMutation.isPending ? 'Draining…' : 'Confirm Drain'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!deregisterTarget}
        onOpenChange={(open) => {
          if (!open && !deregisterMutation.isPending) {
            setDeregisterTarget(null);
          }
        }}
      >
        <DialogContent className="border-border-strong bg-surface-base sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Deregister Worker</DialogTitle>
            <DialogDescription>
              Are you sure you want to deregister worker{' '}
              <span className="text-text-primary font-mono font-medium">
                {deregisterTarget?.hostname}
              </span>
              ? This will permanently remove the worker record from the
              registry.
            </DialogDescription>
          </DialogHeader>

          {deregisterMutation.isError && (
            <div
              role="alert"
              className="border-status-danger-border bg-status-danger-bg text-status-danger-text rounded-md border p-2.5 text-xs"
            >
              {deregisterMutation.error?.message ??
                'Failed to deregister worker'}
            </div>
          )}

          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDeregisterTarget(null)}
              disabled={deregisterMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => {
                if (deregisterTarget) {
                  deregisterMutation.mutate(deregisterTarget.workerId);
                }
              }}
              disabled={deregisterMutation.isPending}
            >
              {deregisterMutation.isPending
                ? 'Deregistering…'
                : 'Confirm Deregister'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={showConnectModal} onOpenChange={setShowConnectModal}>
        <DialogContent className="border-border-subtle bg-surface-base max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
              <HugeiconsIcon icon={ServerStack01Icon} className="h-4 w-4" />
              <span>Connect External Worker via TypeScript SDK</span>
            </DialogTitle>
            <DialogDescription className="text-text-muted text-xs">
              Run distributed workers directly from your Node.js or TypeScript
              services using{' '}
              <code className="text-text-primary font-mono">@aniket-lodh/veyra-sdk</code>{' '}
              without direct PostgreSQL database credentials.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 pt-2 text-xs">
            <div className="space-y-1.5">
              <span className="text-text-primary font-semibold">
                1. Install the SDK
              </span>
              <div className="border-border-subtle bg-surface-elevated rounded-md border p-2 font-mono text-[0.75rem]">
                pnpm add @aniket-lodh/veyra-sdk
              </div>
            </div>

            <div className="space-y-1.5">
              <span className="text-text-primary font-semibold">
                2. Generate an API Key
              </span>
              <p className="text-text-muted">
                Navigate to{' '}
                <Link
                  to="/settings/api-keys"
                  onClick={() => setShowConnectModal(false)}
                  className="text-text-primary hover:text-text-secondary font-medium underline"
                >
                  Settings → API Keys
                </Link>{' '}
                and generate a key with{' '}
                <code className="text-text-primary font-mono">
                  workers:write
                </code>{' '}
                and{' '}
                <code className="text-text-primary font-mono">jobs:write</code>{' '}
                scopes.
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-text-primary font-semibold">
                  3. Worker Implementation
                </span>
                <Badge tone="info" className="font-mono text-[0.625rem]">
                  TypeScript / Node.js
                </Badge>
              </div>
              <div className="border-border-subtle bg-surface-base max-h-64 overflow-y-auto rounded-md border">
                <CodeBlock language="text" defaultWrap>
                  {generateWorkerSnippet('my_custom_task', 'default')}
                </CodeBlock>
              </div>
            </div>
          </div>

          <DialogFooter className="pt-2">
            <DialogClose asChild>
              <Button variant="outline" size="sm">
                Close
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
