import { cn } from '@/lib/utils';
import * as React from 'react';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'border-border flex h-7 w-full rounded-md border bg-transparent px-2 py-1 text-xs',
        'transition-colors outline-none',
        'placeholder:text-muted-foreground',
        'focus-visible:border-ring focus-visible:ring-ring/30 focus-visible:ring-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20 aria-invalid:ring-2',
        // file input — small surface tuned to the same heights as text.
        'file:bg-secondary file:mr-2 file:h-5 file:rounded-sm file:border-0 file:px-2 file:text-[0.625rem] file:font-medium',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
