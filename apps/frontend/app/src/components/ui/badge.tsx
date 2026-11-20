import { cn } from '@/lib/utils';

export type BadgeTone =
  | 'neutral'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'muted';

const TONE_STYLES: Record<BadgeTone, string> = {
  neutral:
    'bg-status-neutral-bg text-status-neutral-text border border-status-neutral-border',
  info: 'bg-status-info-bg text-status-info-text border border-status-info-border',
  success:
    'bg-status-success-bg text-status-success-text border border-status-success-border',
  warning:
    'bg-status-warning-bg text-status-warning-text border border-status-warning-border',
  danger:
    'bg-status-danger-bg text-status-danger-text border border-status-danger-border',
  muted: 'bg-surface-elevated text-text-muted border border-border-subtle',
};

interface BadgeProps {
  tone?: BadgeTone;
  className?: string;
  children: React.ReactNode;
}

export function Badge({ tone = 'neutral', className, children }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm px-1.5 py-0.5 text-[0.6875rem] font-medium',
        TONE_STYLES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
