const STATUS_PAGE_URL = import.meta.env.VITE_STATUS_PAGE_URL;
const UPTIME_BADGE_URL = import.meta.env.VITE_STATUS_BADGE_URL;

export function AppHeader() {
  return (
    <header className="border-border flex h-12 items-center gap-3 border-b px-6">
      <h1 className="text-sm font-medium">Operator console</h1>
      {STATUS_PAGE_URL && UPTIME_BADGE_URL ? (
        <a
          href={STATUS_PAGE_URL}
          target="_blank"
          rel="noreferrer"
          title="Veyra API uptime (24h)"
          className="ml-auto inline-flex items-center"
        >
          <img
            src={UPTIME_BADGE_URL}
            alt="Veyra API 24h uptime"
            height={20}
            className="h-5"
          />
        </a>
      ) : null}
    </header>
  );
}
