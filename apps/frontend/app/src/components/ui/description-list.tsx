import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

interface DescriptionListProps {
  className?: string;
  children: ReactNode;
}

export function DescriptionList({ className, children }: DescriptionListProps) {
  return (
    <dl
      className={cn(
        'grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs',
        className,
      )}
    >
      {children}
    </dl>
  );
}

interface DescriptionItemProps {
  label: string;
  children: ReactNode;
  mono?: boolean;
}

export function DescriptionItem({
  label,
  children,
  mono,
}: DescriptionItemProps) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'min-w-0 break-words',
          mono && 'font-mono text-[0.6875rem]',
        )}
      >
        {children}
      </dd>
    </>
  );
}
