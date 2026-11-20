import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-context';
import { useLiveConnection } from '@/lib/live/use-live-connection';
import { useTheme } from '@/lib/theme';
import {
  ComputerIcon,
  Moon02Icon,
  Sun03Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

const STATUS_PAGE_URL = import.meta.env.VITE_STATUS_PAGE_URL;
const UPTIME_BADGE_URL = import.meta.env.VITE_STATUS_BADGE_URL;

export function AppHeader() {
  const { user, signOut } = useAuth();
  const { status } = useLiveConnection();
  const { mode, resolvedTheme, toggleTheme } = useTheme();
  const showPaused = status === 'paused';

  const themeIcon =
    mode === 'system'
      ? ComputerIcon
      : resolvedTheme === 'dark'
        ? Moon02Icon
        : Sun03Icon;

  const themeLabel =
    mode === 'system' ? `Theme: system (${resolvedTheme})` : `Theme: ${mode}`;

  return (
    <header className="border-border bg-card flex h-12 items-center gap-3 border-b px-6">
      <h1 className="text-sm font-medium">Operator console</h1>
      {showPaused ? (
        <span
          className="text-muted-foreground text-xs"
          title="SSE disconnected; falling back to slow refetch"
        >
          Live updates paused
        </span>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={toggleTheme}
          title={`${themeLabel} — click to switch`}
          aria-label={themeLabel}
        >
          <HugeiconsIcon icon={themeIcon} size={15} />
        </Button>
        {STATUS_PAGE_URL && UPTIME_BADGE_URL ? (
          <a
            href={STATUS_PAGE_URL}
            target="_blank"
            rel="noreferrer"
            title="Veyra API uptime (24h)"
            className="inline-flex items-center"
          >
            <img
              src={UPTIME_BADGE_URL}
              alt="Veyra API 24h uptime"
              height={20}
              className="h-5"
            />
          </a>
        ) : null}
        {user ? (
          <>
            <span className="text-muted-foreground hidden text-xs sm:inline">
              {user.email}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void signOut()}
            >
              Sign out
            </Button>
          </>
        ) : null}
      </div>
    </header>
  );
}
