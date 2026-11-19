export const ROUTES = {
  dashboard: '/',
  jobs: '/jobs',
  jobEnqueue: '/jobs/new',
  jobDetail: '/jobs/:id',
  workers: '/workers',
  workerDetail: '/workers/:id',
  apiKeys: '/api-keys',
} as const;

export type RoutePath = (typeof ROUTES)[keyof typeof ROUTES];

export const jobDetailPath = (id: string) => `/jobs/${id}`;
export const workerDetailPath = (id: string) => `/workers/${id}`;

export const jobsByQueuePath = (queue: string) =>
  `/jobs?queue=${encodeURIComponent(queue)}`;

export const jobsByHandlerPath = (handler: string) =>
  `/jobs?handler=${encodeURIComponent(handler)}`;

export const jobsByStatusPath = (...statuses: string[]) => {
  const sp = new URLSearchParams();
  for (const s of statuses) sp.append('status', s);
  const q = sp.toString();
  return q ? `${ROUTES.jobs}?${q}` : ROUTES.jobs;
};
