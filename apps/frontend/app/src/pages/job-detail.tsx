// Job Detail — drilldown from the Jobs list. Polls while the job is alive
// and stops once it terminates.
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CodeBlock } from '@/components/ui/code-block';
import {
  DescriptionItem,
  DescriptionList,
} from '@/components/ui/description-list';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CANCELLABLE_STATUSES, useCancelJob, useJob } from '@/hooks/api';
import { ApiError } from '@/lib/api/client';
import {
  formatDateTimeUTC,
  formatDurationMs,
  formatRelative,
} from '@/lib/format';
import {
  ROUTES,
  jobsByHandlerPath,
  jobsByQueuePath,
  workerDetailPath,
} from '@/lib/routes';
import type { BackoffStrategy, Job, JobAttempt } from '@/lib/types';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

function formatBackoff(b: BackoffStrategy): string {
  if (b.kind === 'fixed') return `fixed ${b.seconds}s`;
  return `exponential base=${b.baseSeconds}s cap=${b.capSeconds}s`;
}

// Narrowing helpers for the opaque payload/result blobs. The backend stores
// these as JSONB and the contract types them `unknown`; we read the
// http_request fields defensively so a malformed or partial blob renders as
// "—" instead of throwing.
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

// The http_request handler caps responseExcerpt at 2048 bytes
// (responseExcerptMaxBytes in apps/worker/internal/handler/http_request.go).
// If the captured excerpt is at/over that byte length, it was almost
// certainly truncated — surface that in the viewer. Heuristic only; keep in
// step with the handler constant.
const RESPONSE_EXCERPT_MAX_BYTES = 2048;
function isLikelyTruncatedExcerpt(s: string): boolean {
  return new TextEncoder().encode(s).length >= RESPONSE_EXCERPT_MAX_BYTES;
}

function looksLikeJson(s: string): boolean {
  const t = s.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

// HttpRequestDeliveryCard answers "what happened to this delivery?" without
// log-diving: request fields come from payload, response + timing from result
// (populated on a 2xx), and the error class names the failure bucket (the
// full message lives in the Error card below). Pure rendering of existing
// contract fields — no new types, no API change.
function HttpRequestDeliveryCard({ job }: { job: Job }) {
  const payload = asRecord(job.payload);
  const result = asRecord(job.result);
  const url = asString(payload?.url);
  const method = asString(payload?.method) ?? 'POST';
  const statusCode = asNumber(result?.statusCode);
  const durationMs = asNumber(result?.durationMs);
  const contentType = asString(result?.contentType);
  const responseExcerpt = asString(result?.responseExcerpt);
  const dash = <span className="text-muted-foreground">—</span>;
  // jobs.error is durable history — it is NOT cleared when a later attempt
  // succeeds (queue-core keeps the last failure as context). So on a
  // succeeded job a non-null error means "recovered after this failure",
  // not "currently failing". Render it as history, not a live error.
  const recovered = job.status === 'succeeded' && job.error !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>HTTP delivery</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <DescriptionList>
          <DescriptionItem label="Method" mono>
            {method}
          </DescriptionItem>
          <DescriptionItem label="URL" mono>
            {url ?? dash}
          </DescriptionItem>
          <DescriptionItem label="Status code">
            {statusCode !== null ? (
              <span className="tabular-nums">{statusCode}</span>
            ) : (
              dash
            )}
          </DescriptionItem>
          <DescriptionItem label="Duration">
            {durationMs !== null ? (
              <span className="tabular-nums">
                {formatDurationMs(durationMs)}
              </span>
            ) : (
              dash
            )}
          </DescriptionItem>
          <DescriptionItem label="Content-Type" mono>
            {contentType ?? dash}
          </DescriptionItem>
          <DescriptionItem
            label={recovered ? 'Last failure (recovered)' : 'Error class'}
            mono
          >
            {job.error?.class ?? dash}
          </DescriptionItem>
        </DescriptionList>
        {responseExcerpt && (
          <div>
            <div className="text-muted-foreground mb-1 text-xs">
              Response excerpt
            </div>
            <CodeBlock
              language={looksLikeJson(responseExcerpt) ? 'json' : 'text'}
              truncated={isLikelyTruncatedExcerpt(responseExcerpt)}
            >
              {looksLikeJson(responseExcerpt)
                ? prettyJson(responseExcerpt)
                : responseExcerpt}
            </CodeBlock>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EmailDeliveryCard({ job }: { job: Job }) {
  const payload = asRecord(job.payload);
  const result = asRecord(job.result);
  const to = asStringList(payload?.to);
  const from = asString(payload?.from);
  const subject = asString(payload?.subject);
  const messageId = asString(result?.messageId);
  const durationMs = asNumber(result?.durationMs);
  const dash = <span className="text-muted-foreground">—</span>;
  const recovered = job.status === 'succeeded' && job.error !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email delivery</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <DescriptionList>
          <DescriptionItem label="To" mono>
            {to.length > 0 ? to.join(', ') : dash}
          </DescriptionItem>
          <DescriptionItem label="From" mono>
            {from ?? dash}
          </DescriptionItem>
          <DescriptionItem label="Subject">{subject ?? dash}</DescriptionItem>
          <DescriptionItem label="Message-ID" mono>
            {messageId ?? dash}
          </DescriptionItem>
          <DescriptionItem label="Duration">
            {durationMs !== null ? (
              <span className="tabular-nums">
                {formatDurationMs(durationMs)}
              </span>
            ) : (
              dash
            )}
          </DescriptionItem>
          <DescriptionItem
            label={recovered ? 'Last failure (recovered)' : 'Error class'}
            mono
          >
            {job.error?.class ?? dash}
          </DescriptionItem>
        </DescriptionList>
      </CardContent>
    </Card>
  );
}

function AttemptOutcomeCell({ a }: { a: JobAttempt }) {
  if (a.outcome === null) {
    return <span className="text-blue-700">running</span>;
  }
  if (a.outcome === 'succeeded') {
    return <span className="text-emerald-700">succeeded</span>;
  }
  if (a.outcome === 'cancelled') {
    return <span className="text-slate-700">cancelled</span>;
  }
  return <span className="text-red-700">{a.outcome}</span>;
}

export function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: job, isLoading, isError, error, isFetching } = useJob(id);
  const cancelMutation = useCancelJob();
  const [cancelError, setCancelError] = useState<string | null>(null);

  // 404 — the only error we can act on usefully (a clear "job not found"
  // message). Other errors fall through to the generic error UI below.
  const notFound = error instanceof ApiError && error.status === 404;

  if (!id || notFound) {
    return (
      <div className="space-y-4">
        <Breadcrumb id={id} />
        <p className="text-xs">Job not found.</p>
        <Button asChild variant="outline" size="sm">
          <Link to={ROUTES.jobs}>Back to jobs</Link>
        </Button>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-4">
        <Breadcrumb id={id} />
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs"
        >
          Failed to load job: {error?.message ?? 'unknown error'}
        </div>
      </div>
    );
  }

  if (isLoading || !job) {
    return (
      <div className="space-y-4">
        <Breadcrumb id={id} />
        <p className="text-muted-foreground text-xs">Loading…</p>
      </div>
    );
  }

  const isTerminal =
    job.status === 'succeeded' ||
    job.status === 'failed' ||
    job.status === 'dead-lettered' ||
    job.status === 'cancelled';

  const canCancel = CANCELLABLE_STATUSES.has(job.status);

  const onCancel = () => {
    if (
      !window.confirm(
        'Cancel this job? It will not run or retry. If a worker is already executing it, that attempt stops cooperatively — any side effects already started may still complete.',
      )
    ) {
      return;
    }
    setCancelError(null);
    cancelMutation.mutate(job.id, {
      onError: (err) => {
        setCancelError(err.message || 'Cancel failed');
      },
    });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Breadcrumb id={job.id} />
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">{job.handler}</h2>
              <StatusBadge status={job.status} />
              {isFetching && !isTerminal && (
                <span className="text-muted-foreground/60 text-[0.625rem]">
                  · refreshing
                </span>
              )}
            </div>
            <p className="text-muted-foreground text-xs">
              On queue{' '}
              <Link
                to={jobsByQueuePath(job.queue)}
                className="font-mono text-[0.6875rem] hover:underline"
              >
                {job.queue}
              </Link>
              {' · '}attempt {job.attempt} of {job.maxAttempts}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {canCancel ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onCancel}
                disabled={cancelMutation.isPending}
              >
                {cancelMutation.isPending ? 'Cancelling…' : 'Cancel job'}
              </Button>
            ) : job.status === 'cancelled' ? (
              <Button type="button" variant="outline" size="sm" disabled>
                Cancelled
              </Button>
            ) : null}
            {cancelError && (
              <p className="text-destructive max-w-[24rem] text-right text-[0.6875rem]">
                {cancelError}
              </p>
            )}
          </div>
        </div>
      </div>

      {job.handler === 'http_request' && <HttpRequestDeliveryCard job={job} />}
      {job.handler === 'send_email' && <EmailDeliveryCard job={job} />}

      <div className="grid grid-cols-2 gap-3">
        <Card>
          <CardHeader>
            <CardTitle>Identity</CardTitle>
          </CardHeader>
          <CardContent>
            <DescriptionList>
              <DescriptionItem label="Job ID" mono>
                {job.id}
              </DescriptionItem>
              <DescriptionItem label="Handler" mono>
                <Link
                  to={jobsByHandlerPath(job.handler)}
                  className="hover:underline"
                >
                  {job.handler}
                </Link>
              </DescriptionItem>
              <DescriptionItem label="Queue">
                <Link
                  to={jobsByQueuePath(job.queue)}
                  className="font-mono text-[0.6875rem] hover:underline"
                >
                  {job.queue}
                </Link>
              </DescriptionItem>
              <DescriptionItem label="Priority">{job.priority}</DescriptionItem>
              <DescriptionItem label="Idempotency key" mono>
                {job.idempotencyKey ?? (
                  <span className="text-muted-foreground">—</span>
                )}
              </DescriptionItem>
            </DescriptionList>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Lifecycle</CardTitle>
          </CardHeader>
          <CardContent>
            <DescriptionList>
              <DescriptionItem label="Enqueued">
                {formatDateTimeUTC(job.enqueuedAt)}
                <span className="text-muted-foreground">
                  {' '}
                  ({formatRelative(job.enqueuedAt)})
                </span>
              </DescriptionItem>
              <DescriptionItem label="Scheduled for">
                {job.scheduledFor ? (
                  <>
                    {formatDateTimeUTC(job.scheduledFor)}
                    <span className="text-muted-foreground">
                      {' '}
                      ({formatRelative(job.scheduledFor)})
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </DescriptionItem>
              <DescriptionItem label="Started">
                {job.startedAt ? (
                  formatDateTimeUTC(job.startedAt)
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </DescriptionItem>
              <DescriptionItem label="Completed">
                {job.completedAt ? (
                  formatDateTimeUTC(job.completedAt)
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </DescriptionItem>
              <DescriptionItem label="Cancelled">
                {job.cancelledAt ? (
                  formatDateTimeUTC(job.cancelledAt)
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </DescriptionItem>
              <DescriptionItem label="Dead-lettered">
                {job.deadLetteredAt ? (
                  formatDateTimeUTC(job.deadLetteredAt)
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </DescriptionItem>
            </DescriptionList>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Ownership &amp; lease</CardTitle>
          </CardHeader>
          <CardContent>
            <DescriptionList>
              <DescriptionItem label="Current worker">
                {job.currentWorkerId ? (
                  <Link
                    to={workerDetailPath(job.currentWorkerId)}
                    className="font-mono text-[0.6875rem] hover:underline"
                  >
                    {job.currentWorkerId}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </DescriptionItem>
              <DescriptionItem label="Lease expires">
                {job.leaseExpiresAt ? (
                  <>
                    {formatDateTimeUTC(job.leaseExpiresAt)}
                    <span className="text-muted-foreground">
                      {' '}
                      ({formatRelative(job.leaseExpiresAt)})
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </DescriptionItem>
            </DescriptionList>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Retry policy</CardTitle>
          </CardHeader>
          <CardContent>
            <DescriptionList>
              <DescriptionItem label="Attempts">
                <span className="tabular-nums">
                  {job.attempt}
                  <span className="text-muted-foreground">
                    {' / '}
                    {job.maxAttempts}
                  </span>
                </span>
              </DescriptionItem>
              <DescriptionItem label="Backoff" mono>
                {formatBackoff(job.backoff)}
              </DescriptionItem>
              <DescriptionItem label="Next retry">
                {job.nextRetryAt ? (
                  <>
                    {formatDateTimeUTC(job.nextRetryAt)}
                    <span className="text-muted-foreground">
                      {' '}
                      ({formatRelative(job.nextRetryAt)})
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </DescriptionItem>
            </DescriptionList>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Payload</CardTitle>
        </CardHeader>
        <CardContent>
          <CodeBlock language="json">
            {JSON.stringify(job.payload, null, 2)}
          </CodeBlock>
        </CardContent>
      </Card>

      {job.result !== null &&
        (job.handler === 'http_request' || job.handler === 'send_email' ? (
          // Delivery card above is the primary readable result view. Demote
          // the raw object to a default-collapsed disclosure.
          <Card>
            <CardContent className="pt-3">
              <details>
                <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs font-medium select-none">
                  Raw result JSON
                </summary>
                <div className="mt-2">
                  <CodeBlock language="json">
                    {JSON.stringify(job.result, null, 2)}
                  </CodeBlock>
                </div>
              </details>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Result</CardTitle>
            </CardHeader>
            <CardContent>
              <CodeBlock language="json">
                {JSON.stringify(job.result, null, 2)}
              </CodeBlock>
            </CardContent>
          </Card>
        ))}

      {job.error && (
        <Card>
          <CardHeader>
            {/* jobs.error is durable history, not cleared on a later success.
                On a succeeded job it is the failure the job recovered from —
                title it as history so it doesn't read as a live error. */}
            <CardTitle>
              {job.status === 'succeeded'
                ? 'Last failure (recovered)'
                : 'Error'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <DescriptionList>
              <DescriptionItem label="Class" mono>
                {job.error.class}
              </DescriptionItem>
              <DescriptionItem label="Message" mono>
                {job.error.message}
              </DescriptionItem>
              <DescriptionItem label="Occurred at">
                {formatDateTimeUTC(job.error.occurredAt)}
              </DescriptionItem>
            </DescriptionList>
            {job.error.stackTrace && (
              <div>
                <div className="text-muted-foreground mb-1 text-xs">
                  Stack trace
                </div>
                <CodeBlock>{job.error.stackTrace}</CodeBlock>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        <h3 className="text-muted-foreground text-[0.6875rem] font-medium tracking-wide uppercase">
          Attempt history
        </h3>
        <div className="border-border overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16 text-right">#</TableHead>
                <TableHead>Worker</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Ended</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {job.attempts.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-muted-foreground text-center text-xs"
                  >
                    No attempts yet.
                  </TableCell>
                </TableRow>
              ) : (
                job.attempts.map((a) => (
                  <TableRow key={a.attemptNumber}>
                    <TableCell className="text-right tabular-nums">
                      {a.attemptNumber}
                    </TableCell>
                    <TableCell>
                      <Link
                        to={workerDetailPath(a.workerId)}
                        className="font-mono text-[0.6875rem] hover:underline"
                      >
                        {a.workerId}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {formatDateTimeUTC(a.startedAt)}
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {formatDateTimeUTC(a.endedAt)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatDurationMs(a.durationMs)}
                    </TableCell>
                    <TableCell>
                      <AttemptOutcomeCell a={a} />
                    </TableCell>
                    <TableCell className="text-muted-foreground max-w-[32ch] truncate font-mono text-[0.6875rem]">
                      {a.errorMessage ?? '—'}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {isTerminal && (
        <p className="text-muted-foreground text-[0.6875rem]">
          Terminal state. No further attempts will be scheduled automatically.
        </p>
      )}
    </div>
  );
}

function Breadcrumb({ id }: { id: string | undefined }) {
  return (
    <div className="text-xs">
      <Link to={ROUTES.jobs} className="text-muted-foreground hover:underline">
        Jobs
      </Link>{' '}
      <span className="text-muted-foreground">/</span>{' '}
      <span className="font-mono text-[0.6875rem]">{id ?? '—'}</span>
    </div>
  );
}
