import { cn } from '@/lib/utils';
import * as React from 'react';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'border-border flex min-h-24 w-full rounded-md border bg-transparent px-2 py-1.5 text-xs',
        'font-mono leading-relaxed', // monospace because payload is JSON
        'transition-colors outline-none',
        'placeholder:text-muted-foreground',
        'focus-visible:border-ring focus-visible:ring-ring/30 focus-visible:ring-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20 aria-invalid:ring-2',
        'resize-y',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
