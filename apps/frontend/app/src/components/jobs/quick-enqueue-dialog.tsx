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
import { Textarea } from '@/components/ui/textarea';
import { useEnqueueJob } from '@/hooks/api';
import { ApiError } from '@/lib/api/client';
import { validateJsonString } from '@/lib/jobs-helpers';
import { ROUTES } from '@/lib/routes';
import { KNOWN_HANDLERS, type Job, type KnownHandler } from '@/lib/types';
import {
  Add01Icon,
  Alert02Icon,
  ArrowRight01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

const DEFAULT_PAYLOADS: Record<KnownHandler, string> = {
  noop: JSON.stringify({ test: true, message: 'Queue health check' }, null, 2),
  http_request: JSON.stringify(
    { method: 'GET', url: 'https://httpbin.org/get' },
    null,
    2,
  ),
  send_email: JSON.stringify(
    {
      to: ['operator@example.com'],
      from: 'noreply@veyra.internal',
      subject: 'Operational Alert',
      body: 'Queue dispatch test payload',
    },
    null,
    2,
  ),
};

interface QuickEnqueueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  availableQueues?: string[];
  onSuccess?: (job: Job) => void;
}

export function QuickEnqueueDialog({
  open,
  onOpenChange,
  availableQueues = ['default'],
  onSuccess,
}: QuickEnqueueDialogProps) {
  const enqueueMutation = useEnqueueJob();

  const [handler, setHandler] = useState<KnownHandler>('noop');
  const [queue, setQueue] = useState<string>('default');
  const [priority, setPriority] = useState<number>(5);
  const [maxAttempts, setMaxAttempts] = useState<number>(3);
  const [payloadText, setPayloadText] = useState<string>(DEFAULT_PAYLOADS.noop);
  const [idempotencyKey, setIdempotencyKey] = useState<string>('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handleHandlerChange = (newHandler: KnownHandler) => {
    setHandler(newHandler);
    setPayloadText(DEFAULT_PAYLOADS[newHandler]);
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    const validation = validateJsonString(payloadText);
    if (!validation.valid || validation.parsed === undefined) {
      setSubmitError(validation.error ?? 'Invalid JSON payload');
      return;
    }

    enqueueMutation.mutate(
      {
        handler,
        queue: queue.trim() || 'default',
        payload: validation.parsed,
        priority: Number(priority),
        maxAttempts: Number(maxAttempts),
        idempotencyKey: idempotencyKey.trim() || undefined,
      },
      {
        onSuccess: (newJob) => {
          onSuccess?.(newJob);
          onOpenChange(false);
        },
        onError: (err) => {
          if (err instanceof ApiError) {
            setSubmitError(err.message);
          } else {
            setSubmitError('Failed to enqueue job');
          }
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border-strong bg-surface-base sm:max-w-lg">
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <div className="bg-surface-elevated text-text-primary border-border-subtle flex h-8 w-8 items-center justify-center rounded-md border">
                <HugeiconsIcon icon={Add01Icon} className="h-4 w-4" />
              </div>
              <div>
                <DialogTitle className="text-text-primary text-sm font-semibold">
                  Quick Enqueue Job
                </DialogTitle>
                <DialogDescription className="text-text-muted text-xs">
                  Dispatch an execution payload into PostgreSQL queue.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="space-y-3 py-1 text-xs">
            {/* Handler & Queue Row */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="quick-handler">Handler</Label>
                <select
                  id="quick-handler"
                  value={handler}
                  onChange={(e) =>
                    handleHandlerChange(e.target.value as KnownHandler)
                  }
                  className="border-border-subtle bg-surface-base text-text-primary focus:border-border-strong h-8 w-full rounded-md border px-2 text-xs focus:outline-hidden"
                >
                  {KNOWN_HANDLERS.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <Label htmlFor="quick-queue">Queue Name</Label>
                <Input
                  id="quick-queue"
                  list="quick-queues-list"
                  value={queue}
                  onChange={(e) => setQueue(e.target.value)}
                  placeholder="default"
                  className="bg-surface-base border-border-subtle h-8 text-xs"
                />
                <datalist id="quick-queues-list">
                  {availableQueues.map((q) => (
                    <option key={q} value={q} />
                  ))}
                </datalist>
              </div>
            </div>

            {/* Priority & Max Attempts Row */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="quick-priority">Priority (0-9)</Label>
                <Input
                  id="quick-priority"
                  type="number"
                  min={0}
                  max={9}
                  value={priority}
                  onChange={(e) => setPriority(Number(e.target.value))}
                  className="bg-surface-base border-border-subtle h-8 text-xs"
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="quick-max-attempts">Max Attempts</Label>
                <Input
                  id="quick-max-attempts"
                  type="number"
                  min={1}
                  max={20}
                  value={maxAttempts}
                  onChange={(e) => setMaxAttempts(Number(e.target.value))}
                  className="bg-surface-base border-border-subtle h-8 text-xs"
                />
              </div>
            </div>

            {/* Optional Idempotency Key */}
            <div className="space-y-1">
              <Label htmlFor="quick-idempotency">
                Idempotency Key (Optional)
              </Label>
              <Input
                id="quick-idempotency"
                type="text"
                value={idempotencyKey}
                onChange={(e) => setIdempotencyKey(e.target.value)}
                placeholder="e.g. order-checkout-98124"
                className="bg-surface-base border-border-subtle h-8 font-mono text-xs"
              />
            </div>

            {/* Payload JSON */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label htmlFor="quick-payload">Payload (JSON)</Label>
                <span className="text-text-muted text-[0.625rem]">
                  Valid JSON required
                </span>
              </div>
              <Textarea
                id="quick-payload"
                rows={4}
                value={payloadText}
                onChange={(e) => setPayloadText(e.target.value)}
                className="bg-surface-base border-border-subtle resize-y font-mono text-[0.6875rem] leading-relaxed"
              />
            </div>

            {/* Error Banner */}
            {submitError && (
              <div
                role="alert"
                className="border-status-danger-border bg-status-danger-bg text-status-danger-text flex items-start gap-2 rounded-md border p-2.5 text-xs"
              >
                <HugeiconsIcon
                  icon={Alert02Icon}
                  className="h-4 w-4 shrink-0 translate-y-0.5"
                />
                <span>{submitError}</span>
              </div>
            )}

            {/* Guided Link Notice */}
            <div className="border-border-subtle bg-surface-elevated/40 flex items-center justify-between rounded-md border px-3 py-2 text-[0.6875rem]">
              <span className="text-text-muted">
                Need exponential backoff presets or custom scheduling?
              </span>
              <Link
                to={ROUTES.jobEnqueue}
                className="text-text-primary hover:text-text-secondary flex items-center gap-1 font-medium hover:underline"
              >
                <span>Full Builder</span>
                <HugeiconsIcon icon={ArrowRight01Icon} className="h-3 w-3" />
              </Link>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <DialogClose asChild disabled={enqueueMutation.isPending}>
              <Button variant="outline" size="sm" type="button">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              size="sm"
              disabled={enqueueMutation.isPending}
            >
              {enqueueMutation.isPending ? 'Enqueueing…' : 'Enqueue Job'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
