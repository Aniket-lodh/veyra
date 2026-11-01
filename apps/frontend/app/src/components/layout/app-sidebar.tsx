import { NAV_ITEMS } from './nav-links';
import { cn } from '@/lib/utils';
import { HugeiconsIcon } from '@hugeicons/react';
import { NavLink } from 'react-router-dom';

export function AppSidebar() {
  return (
    <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border flex h-full w-56 shrink-0 flex-col border-r">
      <div className="border-sidebar-border flex h-12 shrink-0 items-center border-b px-4">
        <span className="text-sm font-semibold tracking-tight">Veyra</span>
      </div>
      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-xs/relaxed',
                isActive
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                  : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
              )
            }
          >
            <HugeiconsIcon icon={item.icon} size={14} />
            {item.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
