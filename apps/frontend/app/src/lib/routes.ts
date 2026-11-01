export const ROUTES = {
  dashboard: '/',
  jobs: '/jobs',
  jobEnqueue: '/jobs/new',
  jobDetail: '/jobs/:id',
  workers: '/workers',
  workerDetail: '/workers/:id',
} as const;

export type RoutePath = (typeof ROUTES)[keyof typeof ROUTES];

export const jobDetailPath = (id: string) => `/jobs/${id}`;
export const workerDetailPath = (id: string) => `/workers/${id}`;

/** Jobs list filtered to one queue name. */
export const jobsByQueuePath = (queue: string) =>
  `/jobs?queue=${encodeURIComponent(queue)}`;

/** Jobs list filtered to one handler name. */
export const jobsByHandlerPath = (handler: string) =>
  `/jobs?handler=${encodeURIComponent(handler)}`;

/** Jobs list filtered by one or more statuses. */
export const jobsByStatusPath = (...statuses: string[]) => {
  const sp = new URLSearchParams();
  for (const s of statuses) sp.append('status', s);
  const q = sp.toString();
  return q ? `${ROUTES.jobs}?${q}` : ROUTES.jobs;
};
