import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-context';
import { useLiveConnection } from '@/lib/live/use-live-connection';

const STATUS_PAGE_URL = import.meta.env.VITE_STATUS_PAGE_URL;
const UPTIME_BADGE_URL = import.meta.env.VITE_STATUS_BADGE_URL;

export function AppHeader() {
  const { user, signOut } = useAuth();
  const { status } = useLiveConnection();
  const showPaused = status === 'paused';

  return (
    <header className="border-border flex h-12 items-center gap-3 border-b px-6">
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
