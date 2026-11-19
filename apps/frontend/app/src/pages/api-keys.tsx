import { Button } from '@/components/ui/button';
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
import { ApiError } from '@/lib/api/client';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyRow,
  type CreatedApiKey,
} from '@/lib/api/keys';
import { formatRelative } from '@/lib/format';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';

export function ApiKeysPage() {
  const queryClient = useQueryClient();
  const keysQuery = useQuery({
    queryKey: ['api-keys'],
    queryFn: ({ signal }) => listApiKeys(signal),
  });

  const [name, setName] = useState('');
  const [neverExpires, setNeverExpires] = useState(true);
  const [expiresLocal, setExpiresLocal] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);

  const createMutation = useMutation({
    mutationFn: createApiKey,
    onSuccess: (key) => {
      setCreated(key);
      setName('');
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (err) => {
      setFormError(err instanceof ApiError ? err.message : 'Create failed');
    },
  });

  const revokeMutation = useMutation({
    mutationFn: revokeApiKey,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });

  function onCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError('Name is required');
      return;
    }
    let expiresAt: string | null = null;
    if (!neverExpires) {
      if (!expiresLocal) {
        setFormError('Pick an expiry date or choose never expires');
        return;
      }
      const d = new Date(expiresLocal);
      if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) {
        setFormError('Expiry must be in the future');
        return;
      }
      expiresAt = d.toISOString();
    }
    createMutation.mutate({ name: trimmed, expiresAt });
  }

  const rows = keysQuery.data?.keys ?? [];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">API keys</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Create keys for apps and scripts that call the API.
        </p>
      </div>

      <form
        onSubmit={onCreate}
        className="border-border max-w-lg space-y-3 border p-4"
      >
        <h2 className="text-sm font-medium">Create key</h2>
        <div className="space-y-1.5">
          <Label htmlFor="key-name">Name</Label>
          <Input
            id="key-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="payments-worker"
            required
          />
        </div>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={neverExpires}
              onChange={(e) => setNeverExpires(e.target.checked)}
            />
            Never expires
          </label>
          {!neverExpires ? (
            <div className="space-y-1.5">
              <Label htmlFor="key-expires">Expires</Label>
              <Input
                id="key-expires"
                type="datetime-local"
                value={expiresLocal}
                onChange={(e) => setExpiresLocal(e.target.value)}
              />
            </div>
          ) : null}
        </div>
        {formError ? (
          <p className="text-destructive text-xs" role="alert">
            {formError}
          </p>
        ) : null}
        <Button type="submit" disabled={createMutation.isPending}>
          {createMutation.isPending ? 'Creating…' : 'Create key'}
        </Button>
      </form>

      {created ? (
        <div className="border-border max-w-lg space-y-2 border border-amber-600/40 bg-amber-500/5 p-4">
          <p className="text-sm font-medium">Copy this key now</p>
          <p className="text-muted-foreground text-xs">
            It will not be shown again.
          </p>
          <p className="bg-muted rounded px-2 py-2 font-mono text-xs break-all">
            {created.secret}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(created.secret);
            }}
          >
            Copy
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setCreated(null)}
          >
            Dismiss
          </Button>
        </div>
      ) : null}

      <div className="space-y-2">
        <h2 className="text-sm font-medium">Keys</h2>
        {keysQuery.isError ? (
          <p className="text-destructive text-sm">
            {keysQuery.error instanceof ApiError
              ? keysQuery.error.message
              : 'Failed to load keys'}
          </p>
        ) : null}
        <div className="border-border overflow-hidden border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && !keysQuery.isLoading ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-muted-foreground text-xs"
                  >
                    No keys yet.
                  </TableCell>
                </TableRow>
              ) : null}
              {rows.map((k) => (
                <KeyRow
                  key={k.id}
                  row={k}
                  onRevoke={() => revokeMutation.mutate(k.id)}
                  revoking={revokeMutation.isPending}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

function KeyRow({
  row,
  onRevoke,
  revoking,
}: {
  row: ApiKeyRow;
  onRevoke: () => void;
  revoking: boolean;
}) {
  const revoked = Boolean(row.revokedAt);
  return (
    <TableRow className={revoked ? 'opacity-60' : undefined}>
      <TableCell className="text-xs font-medium">{row.name}</TableCell>
      <TableCell className="font-mono text-xs">{row.prefix}</TableCell>
      <TableCell className="text-xs">
        {row.expiresAt ? new Date(row.expiresAt).toLocaleString() : 'Never'}
      </TableCell>
      <TableCell className="text-xs">
        {row.lastUsedAt ? formatRelative(row.lastUsedAt) : 'Never'}
      </TableCell>
      <TableCell className="text-xs">
        {revoked ? 'Revoked' : 'Active'}
      </TableCell>
      <TableCell className="text-right">
        {!revoked ? (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={revoking}
            onClick={onRevoke}
          >
            Revoke
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
