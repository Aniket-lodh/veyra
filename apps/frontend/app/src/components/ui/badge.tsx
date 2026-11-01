import { cn } from '@/lib/utils';

export type BadgeTone =
  | 'neutral'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'muted';

const TONE_STYLES: Record<BadgeTone, string> = {
  neutral: 'bg-muted text-foreground',
  info: 'bg-blue-100 text-blue-700',
  success: 'bg-emerald-100 text-emerald-700',
  warning: 'bg-amber-100 text-amber-700',
  danger: 'bg-red-100 text-red-700',
  muted: 'bg-muted text-muted-foreground',
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
