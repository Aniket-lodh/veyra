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
import { StatusBadge } from '@/components/ui/status-badge';
import { useCancelJob } from '@/hooks/api';
import { ApiError } from '@/lib/api/client';
import type { Job } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  Alert02Icon,
  Cancel01Icon,
  Copy01Icon,
  Tick01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useState } from 'react';

interface JobCancelDialogProps {
  job: Job | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (job: Job) => void;
}

export function JobCancelDialog({
  job,
  open,
  onOpenChange,
  onSuccess,
}: JobCancelDialogProps) {
  const cancelMutation = useCancelJob();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (!job) return null;

  const handleCopyId = () => {
    navigator.clipboard.writeText(job.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleConfirm = () => {
    setErrorMsg(null);
    cancelMutation.mutate(job.id, {
      onSuccess: (updated) => {
        onSuccess?.(updated);
        onOpenChange(false);
      },
      onError: (err) => {
        if (err instanceof ApiError) {
          setErrorMsg(err.message);
        } else {
          setErrorMsg(
            'Failed to cancel job. It may have already succeeded or finished.',
          );
        }
      },
    });
  };

  const isRunning = job.status === 'running';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!cancelMutation.isPending) {
          setErrorMsg(null);
          onOpenChange(next);
        }
      }}
    >
      <DialogContent className="border-border-strong bg-surface-base sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="bg-status-danger-bg text-status-danger-text border-status-danger-border flex h-8 w-8 items-center justify-center rounded-md border">
              <HugeiconsIcon icon={Cancel01Icon} className="h-4 w-4" />
            </div>
            <div>
              <DialogTitle className="text-text-primary text-sm font-semibold">
                Cancel Job
              </DialogTitle>
              <DialogDescription className="text-text-muted text-xs">
                SPEC §6 State Mutation: Move job to terminal cancelled state.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-3 py-1">
          {/* Target Job Metadata */}
          <div className="border-border-subtle bg-surface-elevated/60 space-y-2 rounded-md border p-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-text-muted">Job ID:</span>
              <div className="flex items-center gap-1.5 font-mono">
                <span className="text-text-primary text-[0.6875rem]">
                  {job.id}
                </span>
                <button
                  type="button"
                  onClick={handleCopyId}
                  className="text-text-muted hover:text-text-primary p-0.5"
                  title="Copy Job ID"
                >
                  <HugeiconsIcon
                    icon={copied ? Tick01Icon : Copy01Icon}
                    className={cn(
                      'h-3.5 w-3.5',
                      copied && 'text-status-success-text',
                    )}
                  />
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-text-muted">Current Status:</span>
              <StatusBadge status={job.status} />
            </div>

            <div className="flex items-center justify-between">
              <span className="text-text-muted">Queue / Handler:</span>
              <span className="text-text-primary font-mono text-[0.6875rem]">
                {job.queue} / {job.handler}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-text-muted">Execution Attempt:</span>
              <span className="text-text-primary tabular-nums">
                {job.attempt} of {job.maxAttempts}
              </span>
            </div>
          </div>

          {/* Operational Impact Notice */}
          {isRunning ? (
            <div className="border-status-warning-border bg-status-warning-bg text-status-warning-text flex items-start gap-2 rounded-md border p-2.5 text-xs">
              <HugeiconsIcon
                icon={Alert02Icon}
                className="h-4 w-4 shrink-0 translate-y-0.5"
              />
              <span>
                <strong>Active Worker Lease:</strong> This job is actively
                executing on a worker. Cancelling immediately invalidates its
                lease token. The worker will abort processing on its next lease
                check.
              </span>
            </div>
          ) : (
            <p className="text-text-muted text-xs">
              Cancelling will remove this job from runnable worker claims.
              Succeeded or dead-lettered jobs cannot be cancelled.
            </p>
          )}

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
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <DialogClose asChild disabled={cancelMutation.isPending}>
            <Button variant="outline" size="sm" type="button">
              Keep Job
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            size="sm"
            type="button"
            onClick={handleConfirm}
            disabled={cancelMutation.isPending}
            className="gap-1.5"
          >
            {cancelMutation.isPending ? 'Cancelling…' : 'Confirm Cancel'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
