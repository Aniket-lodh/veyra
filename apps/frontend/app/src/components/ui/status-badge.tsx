import { cn } from '@/lib/utils';

export type JobStatus =
  | 'queued'
  | 'scheduled'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'dead-lettered'
  | 'cancelled';

const STATUS_STYLES: Record<JobStatus, string> = {
  queued:
    'bg-status-neutral-bg text-status-neutral-text border border-status-neutral-border',
  scheduled:
    'bg-status-scheduled-bg text-status-scheduled-text border border-status-scheduled-border',
  running:
    'bg-status-info-bg text-status-info-text border border-status-info-border',
  succeeded:
    'bg-status-success-bg text-status-success-text border border-status-success-border',
  failed:
    'bg-status-danger-bg text-status-danger-text border border-status-danger-border',
  'dead-lettered':
    'bg-status-warning-bg text-status-warning-text border border-status-warning-border',
  cancelled:
    'bg-status-neutral-bg text-status-neutral-text border border-status-neutral-border',
};

export const STATUS_LABEL: Record<JobStatus, string> = {
  queued: 'Queued',
  scheduled: 'Scheduled',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  'dead-lettered': 'Dead-lettered',
  cancelled: 'Cancelled',
};

interface StatusBadgeProps {
  status: JobStatus;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  return (
    <span
      data-status={status}
      className={cn(
        'inline-flex items-center rounded-sm px-1.5 py-0.5 text-[0.6875rem] font-medium',
        STATUS_STYLES[status],
        className,
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
