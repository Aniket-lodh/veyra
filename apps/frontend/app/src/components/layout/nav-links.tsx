import { ROUTES } from '@/lib/routes';
import {
  Add01Icon,
  DashboardSquare01Icon,
  ServerStack01Icon,
  Task01Icon,
} from '@hugeicons/core-free-icons';
import type { HugeiconsIcon } from '@hugeicons/react';
import type { ComponentProps } from 'react';

type IconRef = ComponentProps<typeof HugeiconsIcon>['icon'];

export interface NavItem {
  label: string;
  to: string;
  icon: IconRef;
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', to: ROUTES.dashboard, icon: DashboardSquare01Icon },
  { label: 'Jobs', to: ROUTES.jobs, icon: Task01Icon },
  { label: 'Enqueue', to: ROUTES.jobEnqueue, icon: Add01Icon },
  { label: 'Workers', to: ROUTES.workers, icon: ServerStack01Icon },
];
