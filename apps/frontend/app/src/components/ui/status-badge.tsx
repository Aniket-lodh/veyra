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
  queued: 'bg-muted text-muted-foreground',
  scheduled: 'bg-violet-100 text-violet-700',
  running: 'bg-blue-100 text-blue-700',
  succeeded: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-700',
  'dead-lettered': 'bg-amber-100 text-amber-700',
  cancelled: 'bg-slate-200 text-slate-700',
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
