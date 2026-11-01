// Jobs list — filters are picks where the set is known; search stays free text.
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  STATUS_LABEL,
  StatusBadge,
  type JobStatus,
} from '@/components/ui/status-badge';
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
import { jobDetailPath, jobsByQueuePath, ROUTES } from '@/lib/routes';
import { KNOWN_HANDLERS } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

const PAGE_SIZE = 50;

const STATUS_OPTIONS: JobStatus[] = [
  'queued',
  'running',
  'scheduled',
  'succeeded',
  'failed',
  'dead-lettered',
  'cancelled',
];

const selectClass =
  'h-8 w-full rounded-md border border-border bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30';

/** Selected chip colors mirror StatusBadge so filters read the same as the table. */
const STATUS_CHIP_ON: Record<JobStatus, string> = {
  queued: 'bg-muted text-muted-foreground',
  scheduled: 'bg-violet-100 text-violet-700',
  running: 'bg-blue-100 text-blue-700',
  succeeded: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-700',
  'dead-lettered': 'bg-amber-100 text-amber-700',
  cancelled: 'bg-slate-200 text-slate-700',
};

export function JobsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const stats = useQueueStats();

  const statuses = parseStatusParams(searchParams.getAll('status'));
  const queues = searchParams
    .getAll('queue')
    .map((s) => s.trim())
    .filter(Boolean);
  const handlers = searchParams
    .getAll('handler')
    .map((s) => s.trim())
    .filter(Boolean);
  const search = searchParams.get('search')?.trim() ?? '';
  const page = Math.max(0, Number(searchParams.get('page') ?? 0) | 0);
  const offset = page * PAGE_SIZE;

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

  const queueOptions = buildQueueOptions(
    stats.data?.queues.map((q) => q.name) ?? [],
    queues[0],
  );

  const updateFilter = (mut: (sp: URLSearchParams) => void) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        mut(next);
        next.delete('page');
        return next;
      },
      { replace: false },
    );
  };

  const toggleStatus = (status: JobStatus) => {
    updateFilter((sp) => {
      const current = new Set(sp.getAll('status'));
      if (current.has(status)) current.delete(status);
      else current.add(status);
      sp.delete('status');
      for (const s of STATUS_OPTIONS) {
        if (current.has(s)) sp.append('status', s);
      }
    });
  };

  const clearFilters = () => {
    setSearchParams({}, { replace: false });
  };

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
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Jobs</h2>
          <p className="text-muted-foreground text-xs">
            {data ? (
              <>
                Showing {firstShown.toLocaleString()}–
                {lastShown.toLocaleString()} of {total.toLocaleString()}
                {isFetching && (
                  <span className="text-muted-foreground/60 ml-1">
                    · refreshing…
                  </span>
                )}
              </>
            ) : isLoading ? (
              'Loading…'
            ) : (
              'No data'
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="default" size="sm">
            <Link to={ROUTES.jobEnqueue}>Enqueue</Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </div>

      <div className="border-border space-y-3 rounded-md border p-3">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label>Status</Label>
            {hasFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="text-muted-foreground hover:text-foreground text-[0.625rem] underline-offset-2 hover:underline"
              >
                Clear filters
              </button>
            )}
          </div>
          <div
            className="flex flex-wrap gap-1.5"
            role="group"
            aria-label="Filter by status"
          >
            {STATUS_OPTIONS.map((s) => {
              const on = statuses.includes(s);
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleStatus(s)}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-[0.6875rem] font-medium transition-colors',
                    on
                      ? cn(
                          'ring-foreground/15 border-transparent ring-1',
                          STATUS_CHIP_ON[s],
                        )
                      : 'border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  )}
                >
                  {STATUS_LABEL[s]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="filter-queue">Queue</Label>
            <select
              id="filter-queue"
              value={queues[0] ?? ''}
              onChange={(e) =>
                updateFilter((sp) => {
                  sp.delete('queue');
                  const v = e.target.value;
                  if (v) sp.append('queue', v);
                })
              }
              className={selectClass}
            >
              <option value="">Any queue</option>
              {queueOptions.map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="filter-handler">Handler</Label>
            <select
              id="filter-handler"
              value={handlers[0] ?? ''}
              onChange={(e) =>
                updateFilter((sp) => {
                  sp.delete('handler');
                  const v = e.target.value;
                  if (v) sp.append('handler', v);
                })
              }
              className={selectClass}
            >
              <option value="">Any handler</option>
              {KNOWN_HANDLERS.map((h) => (
                <option key={h} value={h}>
                  {h === 'http_request'
                    ? 'http_request — call a URL'
                    : h === 'send_email'
                      ? 'send_email — SMTP'
                      : 'noop — test / soak'}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="filter-search">Search job ID</Label>
            <Input
              id="filter-search"
              value={search}
              placeholder="Paste or type a job id…"
              onChange={(e) =>
                updateFilter((sp) => {
                  const v = e.target.value;
                  if (v) sp.set('search', v);
                  else sp.delete('search');
                })
              }
            />
          </div>
        </div>
      </div>

      {isError && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs"
        >
          Failed to load jobs: {error?.message ?? 'unknown error'}
        </div>
      )}

      <div className="border-border overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Job ID</TableHead>
              <TableHead>Handler</TableHead>
              <TableHead>Queue</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Attempts</TableHead>
              <TableHead>Enqueued</TableHead>
              <TableHead className="text-right">Age</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.length === 0 && !isLoading ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="text-muted-foreground py-8 text-center text-xs"
                >
                  No jobs match the current filters.
                </TableCell>
              </TableRow>
            ) : (
              jobs.map((j) => (
                <TableRow
                  key={j.id}
                  className="hover:bg-muted/40 cursor-pointer"
                  onClick={() => navigate(jobDetailPath(j.id))}
                >
                  <TableCell
                    className="font-mono text-[0.6875rem]"
                    title={j.id}
                  >
                    {j.id}
                  </TableCell>
                  <TableCell className="font-mono text-[0.6875rem]">
                    {j.handler}
                  </TableCell>
                  <TableCell
                    className="text-muted-foreground"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(jobsByQueuePath(j.queue));
                    }}
                  >
                    <span className="hover:underline">{j.queue}</span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={j.status} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {j.attempt}
                    <span className="text-muted-foreground">
                      {' / '}
                      {j.maxAttempts}
                    </span>
                  </TableCell>
                  <TableCell
                    className="text-muted-foreground tabular-nums"
                    title={formatDateTimeUTC(j.enqueuedAt)}
                  >
                    {formatClockUTC(j.enqueuedAt)}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right tabular-nums">
                    {formatRelative(j.enqueuedAt)}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(jobDetailPath(j.id));
                      }}
                    >
                      Inspect
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-xs">
        <p className="text-muted-foreground">
          Page {page + 1} of{' '}
          {Math.max(1, Math.ceil(total / PAGE_SIZE)).toLocaleString()}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => goToPage(page - 1)}
            disabled={!hasPrev || isFetching}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => goToPage(page + 1)}
            disabled={!hasNext || isFetching}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

function buildQueueOptions(fromStats: string[], selected?: string): string[] {
  const set = new Set<string>(['default', ...fromStats]);
  if (selected) set.add(selected);
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function parseStatusParams(raw: string[]): JobStatus[] {
  const valid = new Set<JobStatus>(STATUS_OPTIONS);
  return raw.filter((s): s is JobStatus => valid.has(s as JobStatus));
}
