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
import { usePauseQueue } from '@/hooks/api';
import { ApiError } from '@/lib/api/client';
import { Alert02Icon, PauseIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useState } from 'react';

interface QueuePauseDialogProps {
  queueName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function QueuePauseDialog({
  queueName,
  open,
  onOpenChange,
  onSuccess,
}: QueuePauseDialogProps) {
  const pauseMutation = usePauseQueue();
  const [reason, setReason] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!queueName) return null;

  const handleConfirm = () => {
    setErrorMsg(null);
    pauseMutation.mutate(
      {
        queue: queueName,
        reason: reason.trim() || undefined,
      },
      {
        onSuccess: () => {
          setReason('');
          onSuccess?.();
          onOpenChange(false);
        },
        onError: (err) => {
          if (err instanceof ApiError) {
            setErrorMsg(err.message);
          } else {
            setErrorMsg('Failed to pause queue. Check permissions or network.');
          }
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pauseMutation.isPending) {
          setErrorMsg(null);
          setReason('');
          onOpenChange(next);
        }
      }}
    >
      <DialogContent className="border-border-strong bg-surface-base sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="bg-status-warning-bg text-status-warning-text border-status-warning-border flex h-8 w-8 items-center justify-center rounded-md border">
              <HugeiconsIcon icon={PauseIcon} className="h-4 w-4" />
            </div>
            <div>
              <DialogTitle className="text-text-primary text-sm font-semibold">
                Pause Queue &ldquo;{queueName}&rdquo;
              </DialogTitle>
              <DialogDescription className="text-text-muted text-xs">
                Temporarily halt job claiming for this queue.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div className="border-border-subtle bg-surface-elevated/60 space-y-2 rounded-md border p-3 text-xs">
            <div className="text-text-secondary">
              When paused, workers will <strong>not claim</strong> any runnable
              jobs from queue{' '}
              <code className="text-text-primary font-mono">{queueName}</code>.
            </div>
            <div className="text-text-muted text-[0.6875rem]">
              In-flight jobs already running under active leases will complete
              or reclaim normally.
            </div>
          </div>

          <div className="space-y-1.5">
            <Label
              htmlFor="pause-reason"
              className="text-text-secondary text-xs"
            >
              Reason (optional)
            </Label>
            <Input
              id="pause-reason"
              placeholder="e.g. Downstream maintenance, database migration"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={pauseMutation.isPending}
              className="border-border-subtle bg-surface-base text-text-primary placeholder:text-text-muted/60 text-xs"
            />
          </div>

          {errorMsg && (
            <div className="bg-status-danger-bg text-status-danger-text border-status-danger-border flex items-start gap-2 rounded-md border p-2.5 text-xs">
              <HugeiconsIcon
                icon={Alert02Icon}
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
              />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <DialogClose asChild disabled={pauseMutation.isPending}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-text-secondary border-border-subtle hover:bg-surface-elevated text-xs"
            >
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={handleConfirm}
            disabled={pauseMutation.isPending}
            className="bg-status-warning-solid hover:bg-status-warning-solid/90 text-text-inverse text-xs font-medium"
          >
            {pauseMutation.isPending ? 'Pausing…' : 'Pause Queue'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
