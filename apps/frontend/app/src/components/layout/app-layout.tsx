import { AppHeader } from './app-header';
import { AppSidebar } from './app-sidebar';
import { Outlet } from 'react-router-dom';

export function AppLayout() {
  return (
    <div className="bg-background text-foreground flex h-dvh overflow-hidden">
      <AppSidebar />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <AppHeader />
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
