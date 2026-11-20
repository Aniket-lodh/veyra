import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CodeBlock } from '@/components/ui/code-block';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useJob, useRetryJob } from '@/hooks/api';
import {
  formatDateTimeUTC,
  formatDurationMs,
  formatRelative,
} from '@/lib/format';
import {
  formatAttemptRatio,
  getPriorityMeta,
  isJobCancellable,
  isJobRetryable,
} from '@/lib/jobs-helpers';
import {
  jobDetailPath,
  jobsByHandlerPath,
  jobsByQueuePath,
  workerDetailPath,
} from '@/lib/routes';
import type { BackoffStrategy, Job, JobAttempt } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  Activity01Icon,
  Alert02Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Clock01Icon,
  Copy01Icon,
  Refresh01Icon,
  ServerStack01Icon,
  Tick01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

interface JobInspectorDrawerProps {
  jobId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCancelRequest: (job: Job) => void;
}

function formatBackoff(b: BackoffStrategy): string {
  if (b.kind === 'fixed') return `fixed ${b.seconds}s`;
  return `exponential base=${b.baseSeconds}s cap=${b.capSeconds}s`;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null
    ? (v as Record<string, unknown>)
    : null;
}
function asString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}
function asStringList(v: unknown): string[] {
  if (typeof v === 'string' && v.trim() !== '') return [v.trim()];
  if (Array.isArray(v)) {
    return v
      .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      .map((x) => x.trim());
  }
  return [];
}
function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function JobInspectorDrawer({
  jobId,
  open,
  onOpenChange,
  onCancelRequest,
}: JobInspectorDrawerProps) {
  const {
    data: job,
    isLoading,
    isError,
    error,
    isFetching,
  } = useJob(jobId ?? undefined);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((curr) => (curr === key ? null : curr));
    }, 2000);
  };

  const priorityMeta = job ? getPriorityMeta(job.priority) : null;
  const cancellable = job ? isJobCancellable(job.status) : false;
  const retryable = job ? isJobRetryable(job.status) : false;
  const retryMutation = useRetryJob();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border-strong bg-surface-base max-h-[88vh] gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <div className="border-border-subtle bg-surface-canvas/60 flex items-center justify-between border-b px-6 py-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <DialogTitle className="text-text-primary font-mono text-sm font-semibold">
                {jobId ?? 'Job Inspector'}
              </DialogTitle>
              {job && <StatusBadge status={job.status} />}
              {priorityMeta && (
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
              )}
              {isFetching && !isLoading && (
                <span className="text-text-muted/60 ml-1 inline-flex items-center gap-1 text-[0.625rem]">
                  <span className="bg-status-info-solid inline-block h-1.5 w-1.5 rounded-full" />
                  live syncing
                </span>
              )}
            </div>
            <DialogDescription className="text-text-muted flex items-center gap-2 font-mono text-xs">
              <span>ULID: {jobId}</span>
              {jobId && (
                <button
                  type="button"
                  onClick={() => handleCopy(jobId, `drawer-ulid-${jobId}`)}
                  className="text-text-muted hover:text-text-primary p-0.5"
                  title="Copy Job ULID"
                >
                  <HugeiconsIcon
                    icon={
                      copiedKey === `drawer-ulid-${jobId}`
                        ? Tick01Icon
                        : Copy01Icon
                    }
                    className={cn(
                      'h-3 w-3',
                      copiedKey === `drawer-ulid-${jobId}` &&
                        'text-status-success-text',
                    )}
                  />
                </button>
              )}
              {job && (
                <>
                  <span>·</span>
                  <span>Queue: {job.queue}</span>
                  <span>·</span>
                  <span>Handler: {job.handler}</span>
                </>
              )}
            </DialogDescription>
          </div>

          <div className="flex items-center gap-2">
            {jobId && (
              <Button asChild variant="outline" size="sm" className="text-xs">
                <Link to={jobDetailPath(jobId)}>
                  <span>Full Page</span>
                  <HugeiconsIcon
                    icon={ArrowRight01Icon}
                    className="ml-1.5 h-3.5 w-3.5"
                  />
                </Link>
              </Button>
            )}
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
        <div className="flex-1 space-y-5 overflow-y-auto p-6 text-xs">
          {isLoading ? (
            <div className="space-y-4">
              <div className="bg-surface-elevated h-24 animate-pulse rounded-md" />
              <div className="bg-surface-elevated h-40 animate-pulse rounded-md" />
            </div>
          ) : isError ? (
            <div
              role="alert"
              className="border-status-danger-border bg-status-danger-bg text-status-danger-text flex items-center gap-2 rounded-md border p-3"
            >
              <HugeiconsIcon icon={Alert02Icon} className="h-4 w-4 shrink-0" />
              <span>Failed to load job details: {error?.message}</span>
            </div>
          ) : !job ? (
            <div className="text-text-muted py-8 text-center">
              Job not found.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="border-border-subtle bg-surface-canvas/40 space-y-2 rounded-md border p-3.5">
                  <div className="text-text-muted flex items-center gap-1.5 text-[0.6875rem] font-medium tracking-wider uppercase">
                    <HugeiconsIcon
                      icon={ServerStack01Icon}
                      className="h-3.5 w-3.5"
                    />
                    Queue & Execution Contract
                  </div>
                  <div className="space-y-1.5 pt-1">
                    <div className="flex justify-between">
                      <span className="text-text-muted">Queue:</span>
                      <Link
                        to={jobsByQueuePath(job.queue)}
                        className="text-text-primary hover:text-text-secondary font-mono hover:underline"
                      >
                        {job.queue}
                      </Link>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-muted">Handler:</span>
                      <Link
                        to={jobsByHandlerPath(job.handler)}
                        className="text-text-primary hover:text-text-secondary font-mono hover:underline"
                      >
                        {job.handler}
                      </Link>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-muted">Attempts:</span>
                      <span className="text-text-primary font-mono tabular-nums">
                        {formatAttemptRatio(job.attempt, job.maxAttempts)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-muted">Backoff:</span>
                      <span className="text-text-primary font-mono text-[0.625rem]">
                        {formatBackoff(job.backoff)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-muted">Idempotency Key:</span>
                      <span className="text-text-primary font-mono text-[0.625rem]">
                        {job.idempotencyKey ?? '—'}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="border-border-subtle bg-surface-canvas/40 space-y-2 rounded-md border p-3.5">
                  <div className="text-text-muted flex items-center gap-1.5 text-[0.6875rem] font-medium tracking-wider uppercase">
                    <HugeiconsIcon icon={Clock01Icon} className="h-3.5 w-3.5" />
                    Lifecycle & Leases
                  </div>
                  <div className="space-y-1.5 pt-1">
                    <div className="flex justify-between">
                      <span className="text-text-muted">Enqueued:</span>
                      <span
                        className="text-text-primary font-mono tabular-nums"
                        title={formatDateTimeUTC(job.enqueuedAt)}
                      >
                        {formatRelative(job.enqueuedAt)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-muted">Scheduled For:</span>
                      <span className="text-text-primary font-mono tabular-nums">
                        {job.scheduledFor
                          ? formatDateTimeUTC(job.scheduledFor)
                          : 'Immediate'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-muted">Current Worker:</span>
                      {job.currentWorkerId ? (
                        <Link
                          to={workerDetailPath(job.currentWorkerId)}
                          className="text-text-primary hover:text-text-secondary font-mono text-[0.625rem] hover:underline"
                        >
                          {job.currentWorkerId}
                        </Link>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-muted">Lease Deadline:</span>
                      <span className="text-text-primary font-mono tabular-nums">
                        {job.leaseExpiresAt
                          ? formatRelative(job.leaseExpiresAt)
                          : '—'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-muted">
                        Completed / State:
                      </span>
                      <span className="text-text-primary font-mono tabular-nums">
                        {job.completedAt
                          ? formatDateTimeUTC(job.completedAt)
                          : job.cancelledAt
                            ? 'Cancelled'
                            : job.deadLetteredAt
                              ? 'Dead-lettered'
                              : 'In Queue'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              {job.handler === 'http_request' && (
                <HttpRequestDrawerCard job={job} />
              )}
              {job.handler === 'send_email' && <EmailDrawerCard job={job} />}
              {job.error && (
                <div className="border-status-danger-border bg-status-danger-bg text-status-danger-text space-y-2 rounded-md border p-3.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[0.6875rem] font-semibold tracking-wider uppercase">
                      {job.status === 'succeeded'
                        ? 'Last Failure (Recovered History)'
                        : 'Error Diagnostic'}
                    </span>
                    <span className="font-mono text-[0.625rem]">
                      {job.error.class}
                    </span>
                  </div>
                  <p className="font-mono text-xs whitespace-pre-wrap">
                    {job.error.message}
                  </p>
                  {job.error.stackTrace && (
                    <div className="pt-1">
                      <CodeBlock language="text">
                        {job.error.stackTrace}
                      </CodeBlock>
                    </div>
                  )}
                </div>
              )}
              <div className="border-border-subtle bg-surface-canvas/30 space-y-2 rounded-md border p-3.5">
                <div className="flex items-center justify-between">
                  <span className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
                    Job Payload (JSON)
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      handleCopy(
                        JSON.stringify(job.payload, null, 2),
                        'drawer-payload-copy',
                      )
                    }
                    className="text-text-muted hover:text-text-primary flex items-center gap-1 text-[0.625rem]"
                  >
                    <HugeiconsIcon
                      icon={
                        copiedKey === 'drawer-payload-copy'
                          ? Tick01Icon
                          : Copy01Icon
                      }
                      className={cn(
                        'h-3 w-3',
                        copiedKey === 'drawer-payload-copy' &&
                          'text-status-success-text',
                      )}
                    />
                    <span>Copy Payload</span>
                  </button>
                </div>
                <CodeBlock language="json">
                  {JSON.stringify(job.payload, null, 2)}
                </CodeBlock>
              </div>
              <div className="space-y-2">
                <div className="text-text-muted flex items-center gap-1.5 text-[0.6875rem] font-medium tracking-wider uppercase">
                  <HugeiconsIcon
                    icon={Activity01Icon}
                    className="h-3.5 w-3.5"
                  />
                  Attempt History ({job.attempts.length})
                </div>
                <div className="border-border-subtle bg-surface-base overflow-hidden rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border-subtle bg-surface-canvas/60">
                        <TableHead className="w-12 text-right">#</TableHead>
                        <TableHead>Worker</TableHead>
                        <TableHead>Started</TableHead>
                        <TableHead className="text-right">Duration</TableHead>
                        <TableHead>Outcome</TableHead>
                        <TableHead>Error Message</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {job.attempts.length === 0 ? (
                        <TableRow>
                          <TableCell
                            colSpan={6}
                            className="text-text-muted py-4 text-center text-xs"
                          >
                            No attempt records recorded yet.
                          </TableCell>
                        </TableRow>
                      ) : (
                        job.attempts.map((a: JobAttempt) => (
                          <TableRow
                            key={a.attemptNumber}
                            className="border-border-subtle"
                          >
                            <TableCell className="text-right font-mono tabular-nums">
                              {a.attemptNumber}
                            </TableCell>
                            <TableCell>
                              <Link
                                to={workerDetailPath(a.workerId)}
                                className="text-text-primary hover:text-text-secondary font-mono text-[0.6875rem] hover:underline"
                              >
                                {a.workerId}
                              </Link>
                            </TableCell>
                            <TableCell className="text-text-muted font-mono tabular-nums">
                              {formatDateTimeUTC(a.startedAt)}
                            </TableCell>
                            <TableCell className="text-right font-mono tabular-nums">
                              {a.durationMs !== null
                                ? formatDurationMs(a.durationMs)
                                : '—'}
                            </TableCell>
                            <TableCell>
                              <span
                                className={cn(
                                  'inline-flex items-center rounded-sm px-1.5 py-0.5 text-[0.625rem] font-medium',
                                  a.outcome === 'succeeded'
                                    ? 'bg-status-success-bg text-status-success-text border-status-success-border border'
                                    : a.outcome === 'failed' ||
                                        a.outcome === 'timeout'
                                      ? 'bg-status-danger-bg text-status-danger-text border-status-danger-border border'
                                      : 'bg-surface-elevated text-text-muted border-border-subtle border',
                                )}
                              >
                                {a.outcome ?? 'running'}
                              </span>
                            </TableCell>
                            <TableCell className="text-text-muted max-w-[20ch] truncate font-mono text-[0.6875rem]">
                              {a.errorMessage ?? '—'}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </>
          )}
        </div>
        {job && (
          <div className="border-border-subtle bg-surface-canvas/60 flex flex-wrap items-center justify-between border-t px-6 py-3">
            <div className="flex items-center gap-2">
              {cancellable ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onCancelRequest(job)}
                  className="border-status-danger-border text-status-danger-text hover:bg-status-danger-bg text-xs"
                >
                  <HugeiconsIcon
                    icon={Cancel01Icon}
                    className="mr-1.5 h-3.5 w-3.5"
                  />
                  Cancel Job
                </Button>
              ) : (
                <span className="text-text-muted text-[0.6875rem]">
                  Status {job.status} is terminal or not cancellable.
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!retryable || retryMutation.isPending}
                title={
                  retryable
                    ? 'Retry this job'
                    : `Status '${job.status}' is not retryable (failed, dead-lettered, or cancelled required)`
                }
                onClick={() => retryMutation.mutate(job.id)}
                className={cn(
                  !retryable && 'text-text-disabled cursor-not-allowed',
                  'gap-1.5 text-xs',
                )}
              >
                <HugeiconsIcon
                  icon={Refresh01Icon}
                  className={cn(
                    'h-3.5 w-3.5',
                    retryMutation.isPending && 'animate-spin',
                  )}
                />
                <span>
                  {retryMutation.isPending ? 'Retrying…' : 'Retry Job'}
                </span>
                {!retryable && (
                  <span className="border-border-subtle bg-surface-elevated text-text-muted ml-1 rounded px-1 py-0.5 text-[0.5625rem]">
                    {job.status}
                  </span>
                )}
              </Button>

              <Button
                variant="outline"
                size="sm"
                disabled
                title="Backend capability pending: PATCH /jobs/:id"
                className="text-text-disabled cursor-not-allowed text-xs"
              >
                <span>Adjust Priority</span>
                <span className="border-border-subtle bg-surface-elevated text-text-muted ml-1.5 rounded px-1 py-0.5 text-[0.5625rem]">
                  API Pending
                </span>
              </Button>

              {job.status === 'scheduled' && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled
                  title="Backend capability pending: PATCH /jobs/:id/reschedule"
                  className="text-text-disabled cursor-not-allowed text-xs"
                >
                  <span>Reschedule</span>
                  <span className="border-border-subtle bg-surface-elevated text-text-muted ml-1.5 rounded px-1 py-0.5 text-[0.5625rem]">
                    API Pending
                  </span>
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function HttpRequestDrawerCard({ job }: { job: Job }) {
  const payload = asRecord(job.payload);
  const result = asRecord(job.result);
  const url = asString(payload?.url);
  const method = asString(payload?.method) ?? 'POST';
  const statusCode = asNumber(result?.statusCode);
  const durationMs = asNumber(result?.durationMs);
  const responseExcerpt = asString(result?.responseExcerpt);

  return (
    <div className="border-border-subtle bg-surface-canvas/30 space-y-2 rounded-md border p-3.5">
      <div className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
        HTTP Delivery Diagnostic
      </div>
      <div className="space-y-1.5 pt-1">
        <div className="flex justify-between">
          <span className="text-text-muted">Request:</span>
          <span className="text-text-primary font-mono text-[0.6875rem]">
            {method} {url ?? '—'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted">HTTP Status:</span>
          <span className="text-text-primary font-mono tabular-nums">
            {statusCode !== null ? statusCode : '—'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted">Response Time:</span>
          <span className="text-text-primary font-mono tabular-nums">
            {durationMs !== null ? formatDurationMs(durationMs) : '—'}
          </span>
        </div>
      </div>
      {responseExcerpt && (
        <div className="pt-1">
          <div className="text-text-muted mb-1 text-[0.625rem]">
            Response Excerpt
          </div>
          <CodeBlock language="text">{responseExcerpt}</CodeBlock>
        </div>
      )}
    </div>
  );
}

function EmailDrawerCard({ job }: { job: Job }) {
  const payload = asRecord(job.payload);
  const result = asRecord(job.result);
  const to = asStringList(payload?.to);
  const from = asString(payload?.from);
  const subject = asString(payload?.subject);
  const messageId = asString(result?.messageId);
  const durationMs = asNumber(result?.durationMs);

  return (
    <div className="border-border-subtle bg-surface-canvas/30 space-y-2 rounded-md border p-3.5">
      <div className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
        Email Delivery Diagnostic
      </div>
      <div className="space-y-1.5 pt-1">
        <div className="flex justify-between">
          <span className="text-text-muted">To:</span>
          <span className="text-text-primary font-mono text-[0.6875rem]">
            {to.length > 0 ? to.join(', ') : '—'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted">From:</span>
          <span className="text-text-primary font-mono text-[0.6875rem]">
            {from ?? '—'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted">Subject:</span>
          <span className="text-text-primary font-mono text-[0.6875rem]">
            {subject ?? '—'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted">Message-ID:</span>
          <span className="text-text-primary font-mono text-[0.6875rem]">
            {messageId ?? '—'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted">Duration:</span>
          <span className="text-text-primary font-mono tabular-nums">
            {durationMs !== null ? formatDurationMs(durationMs) : '—'}
          </span>
        </div>
      </div>
    </div>
  );
}
