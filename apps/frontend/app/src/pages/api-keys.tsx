import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  computeKeyMetrics,
  EXPIRY_PRESETS,
  filterApiKeys,
  generateCurlSnippet,
  getApiKeyLifecycle,
  getKeyStatusBadgeProps,
  KNOWN_SCOPES,
  maskSecret,
  validateCreateKeyInput,
  type KeyLifecycleStatus,
} from '@/lib/api-keys-helpers';
import { ApiError } from '@/lib/api/client';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyRow,
  type CreatedApiKey,
} from '@/lib/api/keys';
import { formatDateTimeUTC, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  Alert02Icon,
  Cancel01Icon,
  Copy01Icon,
  Delete02Icon,
  InformationCircleIcon,
  Key01Icon,
  MoreHorizontalIcon,
  Refresh01Icon,
  Search01Icon,
  Shield01Icon,
  Tick01Icon,
  ViewIcon,
  ViewOffIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState, type FormEvent } from 'react';

type StatusFilterTab =
  | 'all'
  | 'active'
  | 'expiring_soon'
  | 'expired'
  | 'revoked';

export function ApiKeysPage() {
  const queryClient = useQueryClient();

  // Queries & Mutations
  const keysQuery = useQuery({
    queryKey: ['api-keys'],
    queryFn: ({ signal }) => listApiKeys(signal),
  });

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [keyToRevoke, setKeyToRevoke] = useState<ApiKeyRow | null>(null);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);

  // Form State: Defaulting to least-privilege granular scopes (NOT wildcard *)
  const [name, setName] = useState('');
  const [expiryPreset, setExpiryPreset] = useState<string>('90d');
  const [customExpiry, setCustomExpiry] = useState('');
  const [scopeMode, setScopeMode] = useState<'all' | 'custom'>('custom');
  const [selectedScopes, setSelectedScopes] = useState<string[]>(['jobs:read']);
  const [formError, setFormError] = useState<string | null>(null);

  // Search & Filter State
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilterTab>('all');

  // Secret Banner UI State
  const [isSecretMasked, setIsSecretMasked] = useState(false);
  const [secretCopied, setSecretCopied] = useState(false);
  const [curlCopied, setCurlCopied] = useState(false);
  const [copiedPrefixId, setCopiedPrefixId] = useState<string | null>(null);

  // Mutations
  const createMutation = useMutation({
    mutationFn: createApiKey,
    onSuccess: (key) => {
      setCreated(key);
      setCreateDialogOpen(false);
      setName('');
      setExpiryPreset('90d');
      setCustomExpiry('');
      setScopeMode('custom');
      setSelectedScopes(['jobs:read']);
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (err) => {
      setFormError(
        err instanceof ApiError ? err.message : 'Failed to create API key',
      );
    },
  });

  const revokeMutation = useMutation({
    mutationFn: revokeApiKey,
    onSuccess: () => {
      setKeyToRevoke(null);
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (err) => {
      setFormError(
        err instanceof ApiError ? err.message : 'Failed to revoke API key',
      );
    },
  });

  // Copy helpers
  const handleCopySecret = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setSecretCopied(true);
      setTimeout(() => setSecretCopied(false), 2000);
    } catch {
      // Fallback
    }
  }, []);

  const handleCopyCurl = useCallback(async (snippet: string) => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCurlCopied(true);
      setTimeout(() => setCurlCopied(false), 2000);
    } catch {
      // Fallback
    }
  }, []);

  const handleCopyPrefix = useCallback(async (id: string, prefix: string) => {
    try {
      await navigator.clipboard.writeText(prefix);
      setCopiedPrefixId(id);
      setTimeout(() => setCopiedPrefixId(null), 1500);
    } catch {
      // Fallback
    }
  }, []);

  // Form Submission using shared validation helper
  function onCreateSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const validation = validateCreateKeyInput({
      name,
      expiryPreset,
      customExpiry,
      scopeMode,
      selectedScopes,
    });

    if (validation.valid === false) {
      setFormError(validation.error);
      return;
    }

    createMutation.mutate(validation.data);
  }

  // Scope Toggle Handler
  function toggleScope(scope: string) {
    setSelectedScopes((prev) => {
      if (prev.includes(scope)) {
        return prev.filter((s) => s !== scope);
      }
      return [...prev, scope];
    });
  }

  const rawKeys = keysQuery.data?.keys;
  const allKeys = useMemo(() => rawKeys ?? [], [rawKeys]);
  const metrics = useMemo(() => computeKeyMetrics(allKeys), [allKeys]);
  const filteredKeys = useMemo(
    () => filterApiKeys(allKeys, searchQuery, statusFilter),
    [allKeys, searchQuery, statusFilter],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-text-primary text-base font-semibold tracking-tight">
              API keys
            </h1>
            <span className="bg-surface-elevated text-text-muted border-border-subtle rounded-full border px-2 py-0.5 font-mono text-[0.6875rem] font-medium tabular-nums">
              {allKeys.length}
            </span>
          </div>
          <p className="text-text-secondary mt-0.5 text-xs">
            Machine credentials for application backends, SDKs, and background
            workers.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void keysQuery.refetch()}
            disabled={keysQuery.isFetching}
            title="Refresh API keys"
            className="text-text-secondary"
          >
            <HugeiconsIcon
              icon={Refresh01Icon}
              className={cn('size-3.5', keysQuery.isFetching && 'animate-spin')}
            />
            <span>Refresh</span>
          </Button>

          <Button
            type="button"
            size="sm"
            onClick={() => {
              setFormError(null);
              setCreateDialogOpen(true);
            }}
          >
            <HugeiconsIcon icon={Key01Icon} className="size-3.5" />
            <span>Create API key</span>
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
        <div
          role="button"
          tabIndex={0}
          onClick={() => setStatusFilter('all')}
          onKeyDown={(e) => e.key === 'Enter' && setStatusFilter('all')}
          className={cn(
            'group bg-surface-base cursor-pointer rounded-lg border p-3 text-left transition-colors',
            statusFilter === 'all'
              ? 'border-border-strong ring-focus-ring/30 ring-1'
              : 'border-border-subtle hover:border-border-strong',
          )}
        >
          <div className="text-text-muted text-[0.6875rem] font-medium tracking-wider uppercase">
            Total Keys
          </div>
          <div className="text-text-primary mt-1 font-mono text-xl font-semibold tabular-nums">
            {metrics.total}
          </div>
          <div className="text-text-muted mt-0.5 text-[0.6875rem]">
            All configured credentials
          </div>
        </div>

        <div
          role="button"
          tabIndex={0}
          onClick={() => setStatusFilter('active')}
          onKeyDown={(e) => e.key === 'Enter' && setStatusFilter('active')}
          className={cn(
            'group bg-surface-base cursor-pointer rounded-lg border p-3 text-left transition-colors',
            statusFilter === 'active'
              ? 'border-status-success-border ring-status-success-solid/30 ring-1'
              : 'border-border-subtle hover:border-border-strong',
          )}
        >
          <div className="text-text-muted flex items-center justify-between text-[0.6875rem] font-medium tracking-wider uppercase">
            <span>Active</span>
            <span className="bg-status-success-solid size-1.5 rounded-full" />
          </div>
          <div className="text-status-success-text mt-1 font-mono text-xl font-semibold tabular-nums">
            {metrics.active}
          </div>
          <div className="text-text-muted mt-0.5 text-[0.6875rem]">
            Healthy & valid
          </div>
        </div>

        <div
          role="button"
          tabIndex={0}
          onClick={() => setStatusFilter('expiring_soon')}
          onKeyDown={(e) =>
            e.key === 'Enter' && setStatusFilter('expiring_soon')
          }
          className={cn(
            'group bg-surface-base cursor-pointer rounded-lg border p-3 text-left transition-colors',
            statusFilter === 'expiring_soon'
              ? 'border-status-warning-border ring-status-warning-solid/30 ring-1'
              : 'border-border-subtle hover:border-border-strong',
          )}
        >
          <div className="text-text-muted flex items-center justify-between text-[0.6875rem] font-medium tracking-wider uppercase">
            <span>Expiring Soon</span>
            {metrics.expiringSoon > 0 && (
              <span className="bg-status-warning-solid size-1.5 rounded-full" />
            )}
          </div>
          <div
            className={cn(
              'mt-1 font-mono text-xl font-semibold tabular-nums',
              metrics.expiringSoon > 0
                ? 'text-status-warning-text'
                : 'text-text-primary',
            )}
          >
            {metrics.expiringSoon}
          </div>
          <div className="text-text-muted mt-0.5 text-[0.6875rem]">
            Within 7 days
          </div>
        </div>

        <div
          role="button"
          tabIndex={0}
          onClick={() => setStatusFilter('expired')}
          onKeyDown={(e) => e.key === 'Enter' && setStatusFilter('expired')}
          className={cn(
            'group bg-surface-base cursor-pointer rounded-lg border p-3 text-left transition-colors',
            statusFilter === 'expired'
              ? 'border-status-warning-border ring-status-warning-solid/30 ring-1'
              : 'border-border-subtle hover:border-border-strong',
          )}
        >
          <div className="text-text-muted flex items-center justify-between text-[0.6875rem] font-medium tracking-wider uppercase">
            <span>Expired</span>
            {metrics.expired > 0 && (
              <span className="bg-status-warning-solid size-1.5 rounded-full" />
            )}
          </div>
          <div
            className={cn(
              'mt-1 font-mono text-xl font-semibold tabular-nums',
              metrics.expired > 0
                ? 'text-status-warning-text'
                : 'text-text-muted',
            )}
          >
            {metrics.expired}
          </div>
          <div className="text-text-muted mt-0.5 text-[0.6875rem]">
            Past expiration date
          </div>
        </div>

        <div
          role="button"
          tabIndex={0}
          onClick={() => setStatusFilter('revoked')}
          onKeyDown={(e) => e.key === 'Enter' && setStatusFilter('revoked')}
          className={cn(
            'group bg-surface-base cursor-pointer rounded-lg border p-3 text-left transition-colors',
            statusFilter === 'revoked'
              ? 'border-status-danger-border ring-status-danger-solid/30 ring-1'
              : 'border-border-subtle hover:border-border-strong',
          )}
        >
          <div className="text-text-muted flex items-center justify-between text-[0.6875rem] font-medium tracking-wider uppercase">
            <span>Revoked</span>
            {metrics.revoked > 0 && (
              <span className="bg-status-danger-solid size-1.5 rounded-full" />
            )}
          </div>
          <div
            className={cn(
              'mt-1 font-mono text-xl font-semibold tabular-nums',
              metrics.revoked > 0
                ? 'text-status-danger-text'
                : 'text-text-muted',
            )}
          >
            {metrics.revoked}
          </div>
          <div className="text-text-muted mt-0.5 text-[0.6875rem]">
            Invalidated tokens
          </div>
        </div>
      </div>
      {created && (
        <div
          role="region"
          aria-label="New API Key Generated"
          className="border-status-warning-border bg-status-warning-bg space-y-3.5 rounded-lg border p-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <div className="bg-status-warning-solid/15 text-status-warning-text mt-0.5 rounded-md p-1">
                <HugeiconsIcon icon={Alert02Icon} className="size-4" />
              </div>
              <div>
                <h3 className="text-text-primary text-sm font-semibold">
                  Copy your new API key now
                </h3>
                <p className="text-text-secondary mt-0.5 text-xs">
                  This secret will <strong>never be shown again</strong>. Store
                  it securely in your environment configuration, secret manager,
                  or CI pipeline.
                </p>
              </div>
            </div>

            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setCreated(null)}
              className="text-text-muted hover:text-text-primary"
            >
              <HugeiconsIcon icon={Cancel01Icon} className="size-3" />
              <span>Dismiss</span>
            </Button>
          </div>
          <div className="border-border-strong bg-surface-base flex flex-col gap-2 rounded-md border p-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <code className="text-text-primary font-mono text-xs font-medium tracking-tight break-all select-all">
                {isSecretMasked ? maskSecret(created.secret) : created.secret}
              </code>
            </div>

            <div className="flex shrink-0 items-center gap-1.5 self-end sm:self-auto">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setIsSecretMasked(!isSecretMasked)}
                title={isSecretMasked ? 'Reveal secret' : 'Mask secret'}
                className="text-text-muted hover:text-text-primary"
              >
                <HugeiconsIcon
                  icon={isSecretMasked ? ViewIcon : ViewOffIcon}
                  className="size-3.5"
                />
                <span>{isSecretMasked ? 'Reveal' : 'Mask'}</span>
              </Button>

              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => void handleCopySecret(created.secret)}
                className={cn(
                  'transition-all',
                  secretCopied
                    ? 'border-status-success-border bg-status-success-bg text-status-success-text'
                    : 'text-text-primary',
                )}
              >
                <HugeiconsIcon
                  icon={secretCopied ? Tick01Icon : Copy01Icon}
                  className="size-3.5"
                />
                <span>{secretCopied ? 'Copied key!' : 'Copy key'}</span>
              </Button>
            </div>
          </div>
          <div className="border-border-subtle bg-surface-elevated/70 rounded border p-2.5 text-xs">
            <div className="flex items-center justify-between pb-1.5">
              <span className="text-text-secondary text-[0.6875rem] font-medium">
                Test authentication via cURL
              </span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() =>
                  void handleCopyCurl(
                    generateCurlSnippet(created.secret, window.location.origin),
                  )
                }
                className={cn(
                  'h-5 px-1.5 text-[0.625rem]',
                  curlCopied && 'text-status-success-text',
                )}
              >
                <HugeiconsIcon
                  icon={curlCopied ? Tick01Icon : Copy01Icon}
                  className="size-3"
                />
                <span>{curlCopied ? 'Copied command!' : 'Copy curl'}</span>
              </Button>
            </div>
            <code className="text-text-primary block overflow-x-auto font-mono text-[0.6875rem] select-all">
              {generateCurlSnippet(created.secret, window.location.origin)}
            </code>
          </div>
        </div>
      )}
      <div className="space-y-3">
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-1">
            {(
              [
                { id: 'all', label: 'All', count: metrics.total },
                { id: 'active', label: 'Active', count: metrics.active },
                {
                  id: 'expiring_soon',
                  label: 'Expiring Soon',
                  count: metrics.expiringSoon,
                },
                { id: 'expired', label: 'Expired', count: metrics.expired },
                { id: 'revoked', label: 'Revoked', count: metrics.revoked },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setStatusFilter(tab.id)}
                className={cn(
                  'focus-visible:ring-ring/30 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2',
                  statusFilter === tab.id
                    ? 'bg-surface-elevated text-text-primary shadow-xs'
                    : 'text-text-muted hover:bg-surface-elevated/50 hover:text-text-secondary',
                )}
              >
                <span>{tab.label}</span>
                <span
                  className={cn(
                    'py-0.2 rounded-sm px-1 font-mono text-[0.625rem] tabular-nums',
                    statusFilter === tab.id
                      ? 'bg-surface-base text-text-primary'
                      : 'bg-surface-elevated text-text-muted',
                  )}
                >
                  {tab.count}
                </span>
              </button>
            ))}
          </div>
          <div className="relative w-full sm:w-64">
            <HugeiconsIcon
              icon={Search01Icon}
              className="text-text-muted pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
            />
            <Input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name, prefix, scope…"
              className="bg-surface-base h-8 pr-7 pl-8 text-xs"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
                className="text-text-muted hover:text-text-primary absolute top-1/2 right-2 -translate-y-1/2"
              >
                <HugeiconsIcon icon={Cancel01Icon} className="size-3" />
              </button>
            )}
          </div>
        </div>
        {keysQuery.isError && (
          <div
            role="alert"
            className="border-status-danger-border bg-status-danger-bg text-status-danger-text flex items-center justify-between rounded-md border p-3 text-xs"
          >
            <div className="flex items-center gap-2">
              <HugeiconsIcon icon={Alert02Icon} className="size-4 shrink-0" />
              <span>
                {keysQuery.error instanceof ApiError
                  ? keysQuery.error.message
                  : 'Failed to load API keys'}
              </span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => void keysQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        )}
        <div className="border-border-subtle bg-surface-base overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[190px]">Name</TableHead>
                <TableHead className="w-[140px]">Key Prefix</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead className="w-[120px]">Created</TableHead>
                <TableHead className="w-[140px]">Expires</TableHead>
                <TableHead className="w-[120px]">Last Used</TableHead>
                <TableHead className="w-[110px]">Status</TableHead>
                <TableHead className="w-[130px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keysQuery.isLoading && (
                <>
                  {[1, 2, 3].map((idx) => (
                    <TableRow key={`skeleton-${idx}`}>
                      <TableCell>
                        <div className="bg-surface-elevated h-3.5 w-28 animate-pulse rounded" />
                        <div className="bg-surface-elevated/70 mt-1 h-2.5 w-16 animate-pulse rounded" />
                      </TableCell>
                      <TableCell>
                        <div className="bg-surface-elevated h-5 w-24 animate-pulse rounded" />
                      </TableCell>
                      <TableCell>
                        <div className="bg-surface-elevated h-4 w-16 animate-pulse rounded" />
                      </TableCell>
                      <TableCell>
                        <div className="bg-surface-elevated h-3.5 w-20 animate-pulse rounded" />
                      </TableCell>
                      <TableCell>
                        <div className="bg-surface-elevated h-3.5 w-20 animate-pulse rounded" />
                      </TableCell>
                      <TableCell>
                        <div className="bg-surface-elevated h-3.5 w-16 animate-pulse rounded" />
                      </TableCell>
                      <TableCell>
                        <div className="bg-surface-elevated h-4 w-14 animate-pulse rounded" />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="bg-surface-elevated ml-auto h-6 w-14 animate-pulse rounded" />
                      </TableCell>
                    </TableRow>
                  ))}
                </>
              )}
              {!keysQuery.isLoading &&
                filteredKeys.length === 0 &&
                allKeys.length > 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="py-12 text-center">
                      <p className="text-text-primary text-xs font-medium">
                        No API keys match your criteria
                      </p>
                      <p className="text-text-muted mt-0.5 text-[0.6875rem]">
                        Try clearing your search query or selecting a different
                        status filter.
                      </p>
                      <div className="mt-3 flex justify-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          onClick={() => {
                            setSearchQuery('');
                            setStatusFilter('all');
                          }}
                        >
                          Reset filters
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              {!keysQuery.isLoading && allKeys.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-16 text-center">
                    <div className="bg-surface-elevated text-text-muted mx-auto flex size-10 items-center justify-center rounded-full">
                      <HugeiconsIcon icon={Key01Icon} className="size-5" />
                    </div>
                    <h3 className="text-text-primary mt-3 text-sm font-semibold">
                      No API keys minted yet
                    </h3>
                    <p className="text-text-secondary mx-auto mt-1 max-w-sm text-xs">
                      API keys authorize backend workers, SDK clients, and
                      scripts to enqueue jobs and query queue status over the
                      HTTP API.
                    </p>
                    <div className="mt-4">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => {
                          setFormError(null);
                          setCreateDialogOpen(true);
                        }}
                      >
                        <HugeiconsIcon icon={Key01Icon} className="size-3.5" />
                        <span>Create first API key</span>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {!keysQuery.isLoading &&
                filteredKeys.map((k) => {
                  const status = getApiKeyLifecycle(k);
                  const isRevoked = status === 'revoked';

                  return (
                    <TableRow
                      key={k.id}
                      className={cn(
                        'transition-colors',
                        isRevoked && 'bg-surface-elevated/20 opacity-65',
                      )}
                    >
                      <TableCell className="align-middle">
                        <div className="flex flex-col">
                          <span className="text-text-primary text-xs font-medium">
                            {k.name}
                          </span>
                          <span
                            className="text-text-muted truncate font-mono text-[0.625rem] select-all"
                            title={`Key ID: ${k.id}`}
                          >
                            {k.id}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="align-middle">
                        <div className="bg-surface-elevated border-border-subtle inline-flex items-center gap-1 rounded border px-1.5 py-0.5">
                          <code className="text-text-primary font-mono text-[0.6875rem] select-all">
                            {k.prefix}
                          </code>
                          <button
                            type="button"
                            onClick={() =>
                              void handleCopyPrefix(k.id, k.prefix)
                            }
                            title="Copy key prefix"
                            aria-label={`Copy prefix ${k.prefix}`}
                            className="text-text-muted hover:text-text-primary"
                          >
                            <HugeiconsIcon
                              icon={
                                copiedPrefixId === k.id
                                  ? Tick01Icon
                                  : Copy01Icon
                              }
                              className={cn(
                                'size-3',
                                copiedPrefixId === k.id &&
                                  'text-status-success-text',
                              )}
                            />
                          </button>
                        </div>
                      </TableCell>
                      <TableCell className="align-middle">
                        <div className="flex flex-wrap items-center gap-1">
                          {k.scopes.includes('*') ? (
                            <Badge
                              tone="neutral"
                              className="bg-surface-elevated font-mono text-[0.625rem] font-normal"
                            >
                              Full Access (*)
                            </Badge>
                          ) : (
                            k.scopes.map((s) => (
                              <Badge
                                key={s}
                                tone="neutral"
                                className="font-mono text-[0.625rem] font-normal"
                              >
                                {s}
                              </Badge>
                            ))
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-text-secondary align-middle font-mono text-xs tabular-nums">
                        <span title={formatDateTimeUTC(k.createdAt)}>
                          {k.createdAt ? k.createdAt.slice(0, 10) : '—'}
                        </span>
                      </TableCell>
                      <TableCell className="align-middle text-xs">
                        {k.expiresAt ? (
                          <div className="flex flex-col">
                            <span
                              className={cn(
                                'font-mono text-xs tabular-nums',
                                status === 'expiring_soon' &&
                                  'text-status-warning-text font-medium',
                                status === 'expired' &&
                                  'text-text-muted line-through',
                              )}
                              title={formatDateTimeUTC(k.expiresAt)}
                            >
                              {k.expiresAt.slice(0, 10)}
                            </span>
                            <span className="text-text-muted text-[0.625rem]">
                              {formatRelative(k.expiresAt)}
                            </span>
                          </div>
                        ) : (
                          <span className="text-text-muted text-xs">
                            Never expires
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="align-middle text-xs">
                        {k.lastUsedAt ? (
                          <div className="flex flex-col">
                            <span
                              className="text-text-secondary text-xs"
                              title={formatDateTimeUTC(k.lastUsedAt)}
                            >
                              {formatRelative(k.lastUsedAt)}
                            </span>
                            <span className="text-text-muted font-mono text-[0.625rem] tabular-nums">
                              {k.lastUsedAt.slice(11, 16)} UTC
                            </span>
                          </div>
                        ) : (
                          <span className="text-text-muted text-xs">
                            Never used
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="align-middle">
                        <KeyStatusBadge status={status} />
                      </TableCell>
                      <TableCell className="text-right align-middle">
                        <div className="flex items-center justify-end gap-1">
                          {!isRevoked ? (
                            <Button
                              type="button"
                              variant="destructive"
                              size="xs"
                              onClick={() => {
                                setFormError(null);
                                setKeyToRevoke(k);
                              }}
                              className="h-6 px-2 text-xs"
                            >
                              <HugeiconsIcon
                                icon={Delete02Icon}
                                className="size-3"
                              />
                              <span>Revoke</span>
                            </Button>
                          ) : (
                            <span className="text-text-muted pr-1 text-[0.6875rem] font-medium">
                              Revoked
                            </span>
                          )}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                className="text-text-muted hover:text-text-primary size-6"
                                aria-label={`More actions for key ${k.name}`}
                              >
                                <HugeiconsIcon
                                  icon={MoreHorizontalIcon}
                                  className="size-3.5"
                                />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-52">
                              {!isRevoked && (
                                <>
                                  <DropdownMenuItem
                                    onClick={() => {
                                      setFormError(null);
                                      setKeyToRevoke(k);
                                    }}
                                    className="text-status-danger-text focus:bg-status-danger-bg focus:text-status-danger-text cursor-pointer"
                                  >
                                    <HugeiconsIcon
                                      icon={Delete02Icon}
                                      className="size-3.5"
                                    />
                                    <span>Revoke API key</span>
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                </>
                              )}
                              <DropdownMenuLabel>
                                Pending Backend Capabilities
                              </DropdownMenuLabel>
                              <DropdownMenuItem
                                disabled
                                className="text-text-muted flex cursor-not-allowed justify-between"
                              >
                                <span className="flex items-center gap-1.5">
                                  <HugeiconsIcon
                                    icon={Refresh01Icon}
                                    className="size-3.5"
                                  />
                                  <span>Rotate Key</span>
                                </span>
                                <Badge
                                  tone="muted"
                                  className="text-[0.5625rem]"
                                >
                                  Pending
                                </Badge>
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled
                                className="text-text-muted flex cursor-not-allowed justify-between"
                              >
                                <span className="flex items-center gap-1.5">
                                  <HugeiconsIcon
                                    icon={Key01Icon}
                                    className="size-3.5"
                                  />
                                  <span>Edit Scopes</span>
                                </span>
                                <Badge
                                  tone="muted"
                                  className="text-[0.5625rem]"
                                >
                                  Pending
                                </Badge>
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled
                                className="text-text-muted flex cursor-not-allowed justify-between"
                              >
                                <span className="flex items-center gap-1.5">
                                  <HugeiconsIcon
                                    icon={Shield01Icon}
                                    className="size-3.5"
                                  />
                                  <span>IP Allowlist</span>
                                </span>
                                <Badge
                                  tone="muted"
                                  className="text-[0.5625rem]"
                                >
                                  Pending
                                </Badge>
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        </div>
      </div>
      <Dialog
        open={keyToRevoke !== null}
        onOpenChange={(open) => {
          if (!open) setKeyToRevoke(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="text-status-danger-text flex items-center gap-2">
              <HugeiconsIcon icon={Alert02Icon} className="size-5" />
              <DialogTitle>Revoke API Key</DialogTitle>
            </div>
            <DialogDescription>
              Are you sure you want to revoke key{' '}
              <strong className="text-text-primary">{keyToRevoke?.name}</strong>
              ?
            </DialogDescription>
          </DialogHeader>

          {keyToRevoke && (
            <div className="border-border-subtle bg-surface-elevated/70 space-y-2 rounded-md border p-3 text-xs">
              <div className="flex justify-between">
                <span className="text-text-muted">Key Prefix:</span>
                <code className="text-text-primary font-mono font-medium">
                  {keyToRevoke.prefix}
                </code>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Scopes:</span>
                <span className="text-text-secondary font-mono">
                  {keyToRevoke.scopes.join(', ')}
                </span>
              </div>
              <p className="border-border-subtle text-status-danger-text mt-2 border-t pt-2 text-[0.6875rem]">
                Any application, script, or worker authenticating with this key
                will immediately receive <strong>401 Unauthenticated</strong>.
                This action is permanent and cannot be undone.
              </p>
            </div>
          )}

          {formError && (
            <p className="text-status-danger-text text-xs" role="alert">
              {formError}
            </p>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={revokeMutation.isPending}
              >
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={revokeMutation.isPending}
              onClick={() => {
                if (keyToRevoke) {
                  revokeMutation.mutate(keyToRevoke.id);
                }
              }}
            >
              {revokeMutation.isPending
                ? 'Revoking key…'
                : 'Revoke key permanently'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={createDialogOpen}
        onOpenChange={(open) => {
          setCreateDialogOpen(open);
          if (!open) {
            setFormError(null);
          }
        }}
      >
        <DialogContent className="max-w-xl">
          <form onSubmit={onCreateSubmit} className="space-y-4">
            <DialogHeader>
              <div className="text-text-primary flex items-center gap-2">
                <HugeiconsIcon icon={Key01Icon} className="size-4.5" />
                <DialogTitle>Create new API key</DialogTitle>
              </div>
              <DialogDescription>
                Mint a high-entropy Bearer token for server-to-server queue
                integration.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="key-name" className="text-xs font-medium">
                Name / Identifier{' '}
                <span className="text-status-danger-text">*</span>
              </Label>
              <Input
                id="key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. payment-pipeline-worker, github-actions-ci"
                required
                className="bg-surface-base h-8 text-xs"
              />
              <p className="text-text-muted text-[0.6875rem]">
                A recognizable label indicating which machine or service uses
                this token.
              </p>
            </div>
            <div className="space-y-2">
              <Label className="text-xs font-medium">Expiration Policy</Label>
              <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
                {EXPIRY_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => setExpiryPreset(preset.id)}
                    className={cn(
                      'rounded border px-2 py-1 text-center font-mono text-xs transition-colors',
                      expiryPreset === preset.id
                        ? 'border-border-strong bg-surface-elevated text-text-primary ring-focus-ring/30 font-semibold ring-1'
                        : 'border-border-subtle bg-surface-base text-text-muted hover:border-border-strong hover:text-text-primary',
                    )}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              {expiryPreset === 'custom' && (
                <div className="space-y-1 pt-1">
                  <Input
                    id="key-custom-expiry"
                    type="datetime-local"
                    value={customExpiry}
                    onChange={(e) => setCustomExpiry(e.target.value)}
                    className="bg-surface-base h-8 text-xs"
                  />
                  <p className="text-text-muted text-[0.6875rem]">
                    Must be a future date and time in local timezone.
                  </p>
                </div>
              )}
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-medium">
                  Permissions & Scopes
                </Label>
                <div className="flex items-center gap-2 text-xs">
                  <label className="text-text-secondary flex cursor-pointer items-center gap-1.5">
                    <input
                      type="radio"
                      name="scope-mode"
                      checked={scopeMode === 'custom'}
                      onChange={() => {
                        setScopeMode('custom');
                        setSelectedScopes(['jobs:read']);
                      }}
                      className="accent-primary size-3.5"
                    />
                    <span className="text-text-primary font-medium">
                      Granular Scopes (Recommended)
                    </span>
                  </label>
                  <label className="text-text-secondary flex cursor-pointer items-center gap-1.5">
                    <input
                      type="radio"
                      name="scope-mode"
                      checked={scopeMode === 'all'}
                      onChange={() => {
                        setScopeMode('all');
                        setSelectedScopes(['*']);
                      }}
                      className="accent-primary size-3.5"
                    />
                    <span>Full Access (*)</span>
                  </label>
                </div>
              </div>
              {scopeMode === 'all' && (
                <div className="border-status-warning-border bg-status-warning-bg/60 text-status-warning-text flex items-start gap-2.5 rounded-md border p-2.5 text-xs">
                  <HugeiconsIcon
                    icon={Alert02Icon}
                    className="mt-0.5 size-4 shrink-0"
                  />
                  <div>
                    <span className="font-semibold">
                      Security Note: Full Access (*)
                    </span>{' '}
                    grants unrestricted control across all queue operations,
                    cancel permissions, worker inspection, and API key
                    provisioning. For production safety, prefer selecting only
                    the specific granular scopes needed.
                  </div>
                </div>
              )}
              {scopeMode === 'custom' && (
                <div className="border-border-subtle bg-surface-elevated/50 space-y-2 rounded-md border p-2.5">
                  <p className="text-text-muted border-border-subtle border-b pb-1 text-[0.6875rem]">
                    Enforce least privilege by granting only the minimum
                    permissions required for this caller.
                  </p>
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {KNOWN_SCOPES.filter((s) => s.scope !== '*').map((item) => {
                      const isChecked = selectedScopes.includes(item.scope);
                      return (
                        <label
                          key={item.scope}
                          className={cn(
                            'flex cursor-pointer items-start gap-2 rounded border p-2 text-xs transition-colors',
                            isChecked
                              ? 'border-border-strong bg-surface-base'
                              : 'border-border-subtle hover:bg-surface-base/60',
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleScope(item.scope)}
                            className="accent-primary mt-0.5 size-3.5"
                          />
                          <div className="flex flex-col">
                            <span className="text-text-primary font-mono text-[0.6875rem] font-medium">
                              {item.scope}
                            </span>
                            <span className="text-text-muted text-[0.625rem] leading-tight">
                              {item.description}
                            </span>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            <div className="border-border-subtle bg-surface-elevated/30 space-y-2 rounded-md border p-2.5">
              <div className="text-text-muted flex items-center gap-1.5">
                <HugeiconsIcon
                  icon={InformationCircleIcon}
                  className="size-3.5"
                />
                <span className="text-[0.6875rem] font-medium tracking-wider uppercase">
                  Upcoming Governance Controls (API Keys v2)
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                <div className="flex flex-col gap-1 opacity-60">
                  <span className="text-text-muted text-[0.6875rem]">
                    IP / CIDR Allowlist:
                  </span>
                  <div className="flex items-center gap-1">
                    <Input
                      disabled
                      placeholder="e.g. 10.0.0.0/8, 192.168.1.1"
                      className="bg-surface-base h-7 cursor-not-allowed text-[0.6875rem]"
                    />
                    <Badge tone="muted" className="shrink-0 text-[0.5625rem]">
                      Pending
                    </Badge>
                  </div>
                </div>
                <div className="flex flex-col gap-1 opacity-60">
                  <span className="text-text-muted text-[0.6875rem]">
                    Rate Limit (RPS):
                  </span>
                  <div className="flex items-center gap-1">
                    <Input
                      disabled
                      placeholder="e.g. 100 req/s"
                      className="bg-surface-base h-7 cursor-not-allowed text-[0.6875rem]"
                    />
                    <Badge tone="muted" className="shrink-0 text-[0.5625rem]">
                      Pending
                    </Badge>
                  </div>
                </div>
              </div>
            </div>
            {formError && (
              <p className="text-status-danger-text text-xs" role="alert">
                {formError}
              </p>
            )}

            <DialogFooter>
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={createMutation.isPending}
                >
                  Cancel
                </Button>
              </DialogClose>
              <Button
                type="submit"
                size="sm"
                disabled={createMutation.isPending}
              >
                <HugeiconsIcon icon={Shield01Icon} className="size-3.5" />
                <span>
                  {createMutation.isPending ? 'Minting key…' : 'Mint API key'}
                </span>
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * KeyStatusBadge: Renders consistent semantic status badges with dot indicators.
 * Explicitly includes 'Expired' status for past-expiry unrevoked keys.
 */
function KeyStatusBadge({ status }: { status: KeyLifecycleStatus }) {
  const { tone, label } = getKeyStatusBadgeProps(status);

  return (
    <Badge tone={tone} className="gap-1 font-normal">
      <span
        className={cn(
          'size-1 rounded-full',
          tone === 'success' && 'bg-status-success-solid',
          tone === 'warning' && 'bg-status-warning-solid',
          tone === 'danger' && 'bg-status-danger-solid',
        )}
      />
      <span>{label}</span>
    </Badge>
  );
}
