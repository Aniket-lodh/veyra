import { AppLayout } from '@/components/layout/app-layout';
import { ROUTES } from '@/lib/routes';
import { DashboardPage } from '@/pages/dashboard';
import { EnqueuePage } from '@/pages/enqueue';
import { JobDetailPage } from '@/pages/job-detail';
import { JobsPage } from '@/pages/jobs';
import { WorkerDetailPage } from '@/pages/worker-detail';
import { WorkersPage } from '@/pages/workers';
import { createBrowserRouter } from 'react-router-dom';

const relative = (p: string) => p.replace(/^\//, '');

// Route order matters: the static `/jobs/new` must come BEFORE the dynamic
// `/jobs/:id`, otherwise React Router treats "new" as a job id.
export const router = createBrowserRouter([
  {
    path: '/',
    Component: AppLayout,
    children: [
      { index: true, Component: DashboardPage },
      { path: relative(ROUTES.jobs), Component: JobsPage },
      { path: relative(ROUTES.jobEnqueue), Component: EnqueuePage },
      { path: relative(ROUTES.jobDetail), Component: JobDetailPage },
      { path: relative(ROUTES.workers), Component: WorkersPage },
      { path: relative(ROUTES.workerDetail), Component: WorkerDetailPage },
    ],
  },
]);
