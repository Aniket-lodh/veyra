import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useReplayDlq } from '@/hooks/api';
import { ApiError } from '@/lib/api/client';
import type { ReplayDlqResponse } from '@/lib/api/jobs';
import {
  Alert02Icon,
  Refresh01Icon,
  Tick01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useState } from 'react';

interface DlqReplayDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialQueue?: string;
  initialHandler?: string;
  totalDeadLettered?: number;
  onSuccess?: (res: ReplayDlqResponse) => void;
}

export function DlqReplayDialog({
  open,
  onOpenChange,
  initialQueue = '',
  initialHandler = '',
  totalDeadLettered,
  onSuccess,
}: DlqReplayDialogProps) {
  const replayMutation = useReplayDlq();
  const [queue, setQueue] = useState(initialQueue);
  const [handler, setHandler] = useState(initialHandler);
  const [limit, setLimit] = useState('100');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [replayResult, setReplayResult] = useState<ReplayDlqResponse | null>(
    null,
  );

  const handleOpenChange = (next: boolean) => {
    if (!replayMutation.isPending) {
      if (!next) {
        setErrorMsg(null);
        setReplayResult(null);
        setQueue(initialQueue);
        setHandler(initialHandler);
        setLimit('100');
      }
      onOpenChange(next);
    }
  };

  const handleConfirm = () => {
    setErrorMsg(null);
    const parsedLimit = parseInt(limit, 10);
    if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 500) {
      setErrorMsg('Limit must be an integer between 1 and 500.');
      return;
    }

    replayMutation.mutate(
      {
        queue: queue.trim() || undefined,
        handler: handler.trim() || undefined,
        limit: parsedLimit,
      },
      {
        onSuccess: (res) => {
          setReplayResult(res);
          onSuccess?.(res);
        },
        onError: (err) => {
          if (err instanceof ApiError) {
            setErrorMsg(err.message);
          } else {
            setErrorMsg('Failed to replay dead-lettered jobs.');
          }
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border-strong bg-surface-base sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="bg-surface-elevated text-text-primary border-border-subtle flex h-8 w-8 items-center justify-center rounded-md border">
              <HugeiconsIcon icon={Refresh01Icon} className="h-4 w-4" />
            </div>
            <div>
              <DialogTitle className="text-text-primary text-sm font-semibold">
                Replay Dead-Letter Queue
              </DialogTitle>
              <DialogDescription className="text-text-muted text-xs">
                SPEC §8.2 State Mutation: Requeue dead-lettered jobs for
                execution.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {replayResult ? (
          <div className="space-y-4 py-2">
            <div className="border-status-success-border bg-status-success-bg text-status-success-text flex items-start gap-2 rounded-md border p-3 text-xs">
              <HugeiconsIcon
                icon={Tick01Icon}
                className="h-4 w-4 shrink-0 translate-y-0.5"
              />
              <div className="space-y-1">
                <p className="font-semibold">
                  Replayed {replayResult.replayedCount} dead-lettered job(s)
                </p>
                <p className="text-[0.6875rem] opacity-90">
                  Jobs have been transitioned back to queued status with attempt
                  reset to 0 and scheduled for immediate processing.
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => onOpenChange(false)}
              >
                Close
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3 py-1">
            {/* Operational Impact Notice */}
            <div className="border-border-subtle bg-surface-elevated/60 space-y-2 rounded-md border p-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-text-muted">Target State:</span>
                <span className="text-text-primary font-mono font-medium">
                  queued (attempt = 0)
                </span>
              </div>
              {totalDeadLettered != null && (
                <div className="flex items-center justify-between">
                  <span className="text-text-muted">Total in DLQ:</span>
                  <span className="text-text-primary font-medium tabular-nums">
                    {totalDeadLettered.toLocaleString()}
                  </span>
                </div>
              )}
              <p className="text-text-muted mt-1 text-[0.6875rem]">
                Replayed jobs have error and dead-letter timestamps cleared and
                are made immediately visible to workers.
              </p>
            </div>

            {/* Optional Filters */}
            <div className="space-y-2.5 pt-1">
              <div className="space-y-1">
                <Label
                  htmlFor="replay-queue"
                  className="text-text-muted text-[0.6875rem]"
                >
                  Filter by Queue (optional)
                </Label>
                <Input
                  id="replay-queue"
                  placeholder="All queues"
                  value={queue}
                  onChange={(e) => setQueue(e.target.value)}
                  className="h-8 font-mono text-xs"
                  disabled={replayMutation.isPending}
                />
              </div>

              <div className="space-y-1">
                <Label
                  htmlFor="replay-handler"
                  className="text-text-muted text-[0.6875rem]"
                >
                  Filter by Handler (optional)
                </Label>
                <Input
                  id="replay-handler"
                  placeholder="All handlers"
                  value={handler}
                  onChange={(e) => setHandler(e.target.value)}
                  className="h-8 font-mono text-xs"
                  disabled={replayMutation.isPending}
                />
              </div>

              <div className="space-y-1">
                <Label
                  htmlFor="replay-limit"
                  className="text-text-muted text-[0.6875rem]"
                >
                  Batch Limit (1 to 500)
                </Label>
                <Input
                  id="replay-limit"
                  type="number"
                  min="1"
                  max="500"
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  className="h-8 font-mono text-xs"
                  disabled={replayMutation.isPending}
                />
              </div>
            </div>

            {/* Error Banner */}
            {errorMsg && (
              <div
                role="alert"
                className="border-status-danger-border bg-status-danger-bg text-status-danger-text flex items-start gap-2 rounded-md border p-2.5 text-xs"
              >
                <HugeiconsIcon
                  icon={Alert02Icon}
                  className="h-4 w-4 shrink-0 translate-y-0.5"
                />
                <span>{errorMsg}</span>
              </div>
            )}

            <DialogFooter className="gap-2 pt-2 sm:gap-0">
              <DialogClose asChild disabled={replayMutation.isPending}>
                <Button variant="outline" size="sm" type="button">
                  Cancel
                </Button>
              </DialogClose>
              <Button
                size="sm"
                type="button"
                onClick={handleConfirm}
                disabled={replayMutation.isPending}
                className="gap-1.5"
              >
                <HugeiconsIcon icon={Refresh01Icon} className="h-3.5 w-3.5" />
                {replayMutation.isPending ? 'Replaying…' : 'Confirm Replay'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
