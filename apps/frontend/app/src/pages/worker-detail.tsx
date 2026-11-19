import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DescriptionItem,
  DescriptionList,
} from '@/components/ui/description-list';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useWorkers } from '@/hooks/api';
import { formatDateTimeUTC, formatRelative } from '@/lib/format';
import {
  ROUTES,
  jobDetailPath,
  jobsByHandlerPath,
  jobsByQueuePath,
} from '@/lib/routes';
import type { WorkerState } from '@/lib/types';
import { Link, useNavigate, useParams } from 'react-router-dom';

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

export function WorkerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading, isError, error } = useWorkers();

  const worker = data?.workers.find((w) => w.id === id);

  if (!id || (data && !worker)) {
    return (
      <div className="space-y-4">
        <Breadcrumb id={id} />
        <p className="text-xs">Worker not found.</p>
        <Button asChild variant="outline" size="sm">
          <Link to={ROUTES.workers}>Back to workers</Link>
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
          Failed to load worker: {error?.message ?? 'unknown error'}
        </div>
      </div>
    );
  }

  if (isLoading || !worker) {
    return (
      <div className="space-y-4">
        <Breadcrumb id={id} />
        <p className="text-muted-foreground text-xs">Loading…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Breadcrumb id={worker.id} />
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h2 className="font-mono text-base font-semibold">
                {worker.hostname}
              </h2>
              <Badge tone={WORKER_STATE_TONE[worker.state]}>
                {WORKER_STATE_LABEL[worker.state]}
              </Badge>
            </div>
            <p className="text-muted-foreground text-xs">
              Started {formatRelative(worker.startedAt)} · processed{' '}
              {worker.totalProcessed.toLocaleString()} jobs lifetime
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Card>
          <CardHeader>
            <CardTitle>Identity</CardTitle>
          </CardHeader>
          <CardContent>
            <DescriptionList>
              <DescriptionItem label="Hostname" mono>
                {worker.hostname}
              </DescriptionItem>
              <DescriptionItem label="Worker ID" mono>
                {worker.id}
              </DescriptionItem>
              <DescriptionItem label="PID">{worker.pid}</DescriptionItem>
              <DescriptionItem label="Version" mono>
                {worker.version}
              </DescriptionItem>
              <DescriptionItem label="Started">
                {formatDateTimeUTC(worker.startedAt)}
                <span className="text-muted-foreground">
                  {' '}
                  ({formatRelative(worker.startedAt)})
                </span>
              </DescriptionItem>
            </DescriptionList>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Heartbeat &amp; concurrency</CardTitle>
          </CardHeader>
          <CardContent>
            <DescriptionList>
              <DescriptionItem label="Last heartbeat">
                {formatDateTimeUTC(worker.lastHeartbeatAt)}
                <span className="text-muted-foreground">
                  {' '}
                  ({formatRelative(worker.lastHeartbeatAt)})
                </span>
              </DescriptionItem>
              <DescriptionItem label="Interval">
                {worker.heartbeatIntervalSeconds}s
              </DescriptionItem>
              <DescriptionItem label="Max concurrency">
                {worker.maxConcurrency}
              </DescriptionItem>
              <DescriptionItem label="In-flight">
                <span className="tabular-nums">
                  {worker.inFlight}
                  <span className="text-muted-foreground">
                    {' / '}
                    {worker.maxConcurrency}
                  </span>
                </span>
              </DescriptionItem>
              <DescriptionItem label="Total processed">
                {worker.totalProcessed.toLocaleString()}
              </DescriptionItem>
            </DescriptionList>
          </CardContent>
        </Card>

        <Card className="col-span-2">
          <CardHeader>
            <CardTitle>Capabilities</CardTitle>
          </CardHeader>
          <CardContent>
            <DescriptionList>
              <DescriptionItem label="Subscribed queues">
                <div className="flex flex-wrap gap-1">
                  {worker.queues.length === 0 ? (
                    <span className="text-muted-foreground text-[0.6875rem]">
                      —
                    </span>
                  ) : (
                    worker.queues.map((q) => (
                      <Link
                        key={q}
                        to={jobsByQueuePath(q)}
                        className="bg-muted text-foreground hover:bg-muted/70 rounded-sm px-1.5 py-0.5 font-mono text-[0.6875rem]"
                      >
                        {q}
                      </Link>
                    ))
                  )}
                </div>
              </DescriptionItem>
              <DescriptionItem label="Handlers">
                <div className="flex flex-wrap gap-1">
                  {worker.handlers.length === 0 ? (
                    <span className="text-muted-foreground text-[0.6875rem]">
                      —
                    </span>
                  ) : (
                    worker.handlers.map((h) => (
                      <Link
                        key={h}
                        to={jobsByHandlerPath(h)}
                        className="bg-muted text-foreground hover:bg-muted/70 rounded-sm px-1.5 py-0.5 font-mono text-[0.6875rem]"
                      >
                        {h}
                      </Link>
                    ))
                  )}
                </div>
              </DescriptionItem>
            </DescriptionList>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-2">
        <h3 className="text-muted-foreground text-[0.6875rem] font-medium tracking-wide uppercase">
          Active leases
        </h3>
        <div className="border-border rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job ID</TableHead>
                <TableHead>Handler</TableHead>
                <TableHead>Queue</TableHead>
                <TableHead className="text-right">Attempt</TableHead>
                <TableHead>Leased at</TableHead>
                <TableHead>Lease expires</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {worker.leases.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-muted-foreground text-center text-xs"
                  >
                    No active leases.
                  </TableCell>
                </TableRow>
              ) : (
                worker.leases.map((l) => (
                  <TableRow
                    key={l.jobId}
                    className="hover:bg-muted/40 cursor-pointer"
                    onClick={() => navigate(jobDetailPath(l.jobId))}
                  >
                    <TableCell className="font-mono text-[0.6875rem]">
                      {l.jobId}
                    </TableCell>
                    <TableCell>{l.handler}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {l.queue}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {l.attempt}
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {formatRelative(l.leasedAt)}
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {formatRelative(l.leaseExpiresAt)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <p className="text-muted-foreground text-[0.6875rem]">
        Recent jobs by this worker live in{' '}
        <Link to={ROUTES.jobs} className="text-foreground hover:underline">
          the jobs list
        </Link>{' '}
        once the api exposes per-worker filtering.
      </p>
    </div>
  );
}

function Breadcrumb({ id }: { id: string | undefined }) {
  return (
    <div className="text-xs">
      <Link
        to={ROUTES.workers}
        className="text-muted-foreground hover:underline"
      >
        Workers
      </Link>{' '}
      <span className="text-muted-foreground">/</span>{' '}
      <span className="font-mono text-[0.6875rem]">{id ?? '—'}</span>
    </div>
  );
}
