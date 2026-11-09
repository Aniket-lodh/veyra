import { Badge, type BadgeTone } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useWorkers } from '@/hooks/api';
import { formatRelative } from '@/lib/format';
import { workerDetailPath } from '@/lib/routes';
import type { WorkerState } from '@/lib/types';
import { useNavigate } from 'react-router-dom';

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

export function WorkersPage() {
  const navigate = useNavigate();
  const { data, isLoading, isFetching, isError, error } = useWorkers();
  const workers = data?.workers ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-base font-semibold">Workers</h2>
          <p className="text-muted-foreground text-xs">
            {isLoading
              ? 'Loading…'
              : `${workers.length} worker${workers.length === 1 ? '' : 's'} registered`}
            {isFetching && !isLoading && (
              <span className="text-muted-foreground/60 ml-1">
                · refreshing…
              </span>
            )}
          </p>
        </div>
      </div>

      {isError && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs"
        >
          Failed to load workers: {error?.message ?? 'unknown error'}
        </div>
      )}

      <div className="border-border rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Hostname</TableHead>
              <TableHead>Worker ID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Queues</TableHead>
              <TableHead className="text-right">In flight</TableHead>
              <TableHead className="text-right">Heartbeat</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {workers.length === 0 && !isLoading ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="text-muted-foreground py-8 text-center text-xs"
                >
                  No workers registered.
                </TableCell>
              </TableRow>
            ) : (
              workers.map((w) => {
                const stale = isHeartbeatStale(
                  w.lastHeartbeatAt,
                  w.heartbeatIntervalSeconds,
                );
                return (
                  <TableRow
                    key={w.id}
                    className="hover:bg-muted/40 cursor-pointer"
                    onClick={() => navigate(workerDetailPath(w.id))}
                  >
                    {/* Hostname is the stable identity — see file header. */}
                    <TableCell className="font-mono text-[0.6875rem]">
                      {w.hostname}
                    </TableCell>
                    <TableCell
                      className="text-muted-foreground font-mono text-[0.625rem]"
                      title={w.id}
                    >
                      {w.id.slice(-8)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Badge tone={WORKER_STATE_TONE[w.state]}>
                          {WORKER_STATE_LABEL[w.state]}
                        </Badge>
                        {stale && w.state !== 'disconnected' && (
                          <span
                            className="text-[0.625rem] text-amber-600"
                            title="Heartbeat older than 3× interval — worker may have died without deregistering."
                          >
                            stale
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-[0.6875rem]">
                      {w.version}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {w.queues.join(', ')}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {w.inFlight}
                      <span className="text-muted-foreground">
                        {' / '}
                        {w.maxConcurrency}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right tabular-nums">
                      {formatRelative(w.lastHeartbeatAt)}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function isHeartbeatStale(
  lastHeartbeatAt: string,
  heartbeatIntervalSeconds: number,
): boolean {
  const last = Date.parse(lastHeartbeatAt);
  if (Number.isNaN(last)) return false;
  const ageMs = Date.now() - last;
  return ageMs > heartbeatIntervalSeconds * 3 * 1000;
}
