import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CodeBlock } from '@/components/ui/code-block';
import { Input } from '@/components/ui/input';
import { JsonEditor } from '@/components/ui/json-editor';
import { Label } from '@/components/ui/label';
import { StatusBadge } from '@/components/ui/status-badge';
import { Textarea } from '@/components/ui/textarea';
import {
  useEnqueueJob,
  useQueueStats,
  useValidateJob,
  useWorkers,
} from '@/hooks/api';
import { ApiError } from '@/lib/api/client';
import type { EnqueuedJob } from '@/lib/api/jobs';
import {
  BACKOFF_PRESETS,
  BODYLESS_METHODS,
  DEFAULT_CUSTOM_PAYLOAD_EXAMPLE,
  HTTP_METHODS,
  INITIAL_ENQUEUE_FORM,
  STARTER_PRESETS,
  buildEffectivePayload,
  computeQueueReadiness,
  computeScheduledTime,
  ensureContentType,
  generateCurlSnippet,
  generateIdempotencyKey,
  generateWorkerSnippet,
  hasContentType,
  resolveEffectiveHandlerName,
  validateAndParseEnqueueForm,
  type BackoffPresetId,
  type EnqueueFormState,
  type HeaderRow,
  type HttpMethod,
} from '@/lib/enqueue-helpers';
import { extractQueueOptions } from '@/lib/jobs-helpers';
import { jobDetailPath } from '@/lib/routes';
import { cn } from '@/lib/utils';
import {
  Add01Icon,
  Alert02Icon,
  ArrowRight01Icon,
  Clock01Icon,
  Copy01Icon,
  Key01Icon,
  Refresh01Icon,
  ServerStack01Icon,
  Task01Icon,
  Tick01Icon,
  ViewIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useCallback, useMemo, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

const selectClass =
  'border-border-subtle bg-surface-base text-text-primary h-8 w-full rounded-md border px-2 text-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30';

export function EnqueuePage() {
  const navigate = useNavigate();
  const [form, setForm] = useState<EnqueueFormState>(INITIAL_ENQUEUE_FORM);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validationField, setValidationField] = useState<string | null>(null);
  const [previewTab, setPreviewTab] = useState<'payload' | 'curl' | 'worker'>(
    'payload',
  );
  const [submissionSuccess, setSubmissionSuccess] =
    useState<EnqueuedJob | null>(null);
  const [idempotencyConflict, setIdempotencyConflict] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [dryRunResult, setDryRunResult] = useState<{
    valid: boolean;
    error?: string;
  } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Queries for live queue and worker readiness
  const statsQuery = useQueueStats();
  const workersQuery = useWorkers();

  const availableQueues = useMemo(() => {
    return extractQueueOptions(statsQuery.data?.queues, form.queue);
  }, [statsQuery.data?.queues, form.queue]);

  const effectiveHandler = useMemo(
    () => resolveEffectiveHandlerName(form),
    [form],
  );

  const readiness = useMemo(() => {
    return computeQueueReadiness(
      form.queue,
      effectiveHandler,
      statsQuery.data,
      workersQuery.data?.workers,
      statsQuery.isLoading || workersQuery.isLoading,
    );
  }, [
    form.queue,
    effectiveHandler,
    statsQuery.data,
    workersQuery.data?.workers,
    statsQuery.isLoading,
    workersQuery.isLoading,
  ]);

  const effectivePayloadRes = useMemo(() => {
    return buildEffectivePayload(form);
  }, [form]);

  const mutation = useEnqueueJob({
    onSuccess: (job) => {
      setSubmissionSuccess(job);
      setIdempotencyConflict(null);
      setValidationError(null);
      setValidationField(null);
      setDryRunResult(null);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        setIdempotencyConflict({
          key: form.idempotencyKey.trim(),
          message: err.message,
        });
      } else {
        setValidationError(err instanceof ApiError ? err.message : String(err));
      }
    },
  });

  const dryRunMutation = useValidateJob({
    onSuccess: (res) => {
      setDryRunResult(res);
      if (res.valid) {
        setValidationError(null);
        setValidationField(null);
      } else if (res.error) {
        setValidationError(res.error);
      }
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      setDryRunResult({ valid: false, error: msg });
      setValidationError(msg);
    },
  });

  const update = <K extends keyof EnqueueFormState>(
    key: K,
    value: EnqueueFormState[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setValidationError(null);
    setValidationField(null);
    setDryRunResult(null);
    if (key === 'idempotencyKey') {
      setIdempotencyConflict(null);
    }
  };

  const handleCopy = useCallback(
    (text: string, id: string, e?: React.MouseEvent) => {
      e?.stopPropagation();
      navigator.clipboard.writeText(text).then(() => {
        setCopiedKey(id);
        window.setTimeout(() => setCopiedKey(null), 1600);
      });
    },
    [],
  );

  const setHeader = (i: number, field: keyof HeaderRow, value: string) => {
    setForm((prev) => {
      const headers = prev.httpHeaders.map((h, idx) =>
        idx === i ? { ...h, [field]: value } : h,
      );
      return { ...prev, httpHeaders: headers };
    });
  };

  const addHeader = () => {
    setForm((prev) => ({
      ...prev,
      httpHeaders: [...prev.httpHeaders, { key: '', value: '' }],
    }));
  };

  const removeHeader = (i: number) => {
    setForm((prev) => {
      const filtered = prev.httpHeaders.filter((_, idx) => idx !== i);
      return {
        ...prev,
        httpHeaders: filtered.length ? filtered : [{ key: '', value: '' }],
      };
    });
  };

  const handleHttpBodyChange = (body: string) => {
    setDryRunResult(null);
    setForm((prev) => {
      let headers = prev.httpHeaders;
      if (body.trim() !== '' && !hasContentType(headers)) {
        headers = ensureContentType(headers, 'application/json');
      }
      return { ...prev, httpBody: body, httpHeaders: headers };
    });
  };

  const handleBackoffPresetSelect = (presetId: BackoffPresetId) => {
    setDryRunResult(null);
    if (presetId === 'custom') {
      setForm((prev) => ({ ...prev, backoffPreset: 'custom' }));
      return;
    }
    const preset = BACKOFF_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;

    const strategy = preset.strategy;
    if (strategy.kind === 'exponential') {
      const { baseSeconds, capSeconds } = strategy;
      setForm((prev) => ({
        ...prev,
        backoffPreset: presetId,
        backoffKind: 'exponential',
        backoffBaseSeconds: baseSeconds,
        backoffCapSeconds: capSeconds,
      }));
    } else {
      const { seconds } = strategy;
      setForm((prev) => ({
        ...prev,
        backoffPreset: presetId,
        backoffKind: 'fixed',
        backoffFixedSeconds: seconds,
      }));
    }
  };

  const handleScheduleOffset = (minutes: number) => {
    const val = computeScheduledTime(minutes);
    update('scheduledFor', val);
  };

  const handleGenerateKey = (type: 'uuid' | 'ulid') => {
    const key = generateIdempotencyKey(type);
    update('idempotencyKey', key);
  };

  const handleToggleRawMode = () => {
    setDryRunResult(null);
    setForm((prev) => {
      const nextRawMode = !prev.rawMode;
      let nextRawPayload = prev.rawPayload;
      if (nextRawMode && nextRawPayload.trim() === '') {
        const payloadRes = buildEffectivePayload({ ...prev, rawMode: false });
        nextRawPayload = JSON.stringify(payloadRes.payload ?? {}, null, 2);
      }
      return {
        ...prev,
        rawMode: nextRawMode,
        rawPayload: nextRawPayload,
      };
    });
  };

  const handleSubmit = (e?: { preventDefault: () => void }) => {
    e?.preventDefault();
    if (mutation.isPending) return;
    setValidationError(null);
    setValidationField(null);
    setIdempotencyConflict(null);
    setDryRunResult(null);

    const result = validateAndParseEnqueueForm(form);
    if (!result.ok) {
      if ('error' in result) {
        setValidationError(result.error);
        if (result.field) setValidationField(result.field);
      }
      return;
    }

    mutation.mutate(result.value);
  };

  const handleDryRun = () => {
    if (dryRunMutation.isPending || mutation.isPending) return;
    setValidationError(null);
    setValidationField(null);
    setDryRunResult(null);

    const result = validateAndParseEnqueueForm(form);
    if (!result.ok) {
      if ('error' in result) {
        setValidationError(result.error);
        if (result.field) setValidationField(result.field);
        setDryRunResult({ valid: false, error: result.error });
      }
      return;
    }

    dryRunMutation.mutate(result.value);
  };

  const handleRetryWithNewKey = () => {
    if (mutation.isPending) return;
    const newKey = generateIdempotencyKey('ulid');
    setForm((prev) => ({ ...prev, idempotencyKey: newKey }));
    setIdempotencyConflict(null);
    setValidationError(null);
    setDryRunResult(null);

    const result = validateAndParseEnqueueForm({
      ...form,
      idempotencyKey: newKey,
    });
    if (result.ok) {
      mutation.mutate(result.value);
    }
  };

  const handleFormKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!mutation.isPending) {
        handleSubmit();
      }
    }
  };

  // Generated cURL representation for right-hand column
  const parsedForCurl = useMemo(() => {
    const parsed = validateAndParseEnqueueForm(form);
    if (parsed.ok) return parsed.value;
    return {
      handler: effectiveHandler || 'http_request',
      queue: form.queue.trim() || 'default',
      priority: form.priority,
      maxAttempts: form.maxAttempts,
      payload: effectivePayloadRes.payload ?? {},
      idempotencyKey: form.idempotencyKey.trim() || undefined,
      scheduledFor: form.scheduledFor.trim() || undefined,
    };
  }, [form, effectiveHandler, effectivePayloadRes]);

  const curlSnippet = useMemo(
    () => generateCurlSnippet(parsedForCurl),
    [parsedForCurl],
  );

  const workerSnippet = useMemo(
    () => generateWorkerSnippet(effectiveHandler, form.queue),
    [effectiveHandler, form.queue],
  );

  const isBodylessHttp =
    form.handlerType === 'http_request' &&
    BODYLESS_METHODS.has(form.httpMethod) &&
    form.httpBody.trim() !== '';

  return (
    <div className="mx-auto max-w-7xl space-y-5 pb-12">
      {/* Page Header & Starter Presets Bar */}
      <div className="border-border-subtle bg-surface-base flex flex-col justify-between gap-4 rounded-lg border p-4 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <div className="bg-surface-elevated text-text-primary border-border-subtle flex h-8 w-8 items-center justify-center rounded-md border">
              <HugeiconsIcon icon={Add01Icon} className="h-4 w-4" />
            </div>
            <div>
              <h1 className="text-text-primary text-sm font-semibold tracking-tight sm:text-base">
                Enqueue Job
              </h1>
              <p className="text-text-muted text-xs">
                Dispatch an execution payload into PostgreSQL queue with retry
                policy and routing.
              </p>
            </div>
          </div>
        </div>

        {/* Starter Presets */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-text-muted mr-1 text-[0.6875rem] font-medium tracking-wide uppercase">
            Starter Presets:
          </span>
          {STARTER_PRESETS.map((preset) => (
            <Button
              key={preset.label}
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                setForm((prev) => ({
                  ...prev,
                  handlerType: preset.handlerType,
                  rawMode: false,
                  ...preset.patch,
                }));
                setValidationError(null);
                setValidationField(null);
                setIdempotencyConflict(null);
                setDryRunResult(null);
              }}
              className="text-[0.6875rem]"
              title={preset.description}
            >
              {preset.label}
            </Button>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              setForm(INITIAL_ENQUEUE_FORM);
              setValidationError(null);
              setValidationField(null);
              setIdempotencyConflict(null);
              setSubmissionSuccess(null);
              setDryRunResult(null);
              mutation.reset();
            }}
            className="text-text-muted hover:text-text-primary text-[0.6875rem]"
          >
            Reset
          </Button>
        </div>
      </div>

      {/* Main 2-Column Operational Workbench */}
      <form onSubmit={handleSubmit} onKeyDown={handleFormKeyDown}>
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
          {/* ========================================================= */}
          {/* LEFT COLUMN: Structured Configuration & Payload Authoring */}
          {/* ========================================================= */}
          <div className="space-y-5 lg:col-span-7">
            {/* Section 1: Handler Type & Mode Selection */}
            <Card className="border-border-subtle bg-surface-base">
              <CardHeader className="border-border-subtle flex flex-row items-center justify-between border-b pb-2.5">
                <CardTitle className="text-text-primary flex items-center gap-1.5 font-medium">
                  <HugeiconsIcon icon={Task01Icon} className="h-3.5 w-3.5" />
                  <span>Handler & Execution Mode</span>
                </CardTitle>
                <label className="text-text-secondary hover:text-text-primary flex cursor-pointer items-center gap-1.5 text-xs select-none">
                  <input
                    type="checkbox"
                    checked={form.rawMode}
                    onChange={handleToggleRawMode}
                    className="border-border-strong text-primary accent-primary h-3.5 w-3.5 rounded-sm"
                  />
                  <span>Edit raw JSON payload</span>
                </label>
              </CardHeader>
              <CardContent className="space-y-4 pt-3.5">
                <div className="space-y-1.5">
                  <Label htmlFor="handler-type-select">Worker Handler</Label>
                  <div
                    className="grid grid-cols-2 gap-1.5 sm:grid-cols-4"
                    role="group"
                    aria-label="Worker Handler"
                  >
                    {(
                      [
                        { id: 'http_request', label: 'HTTP Request' },
                        { id: 'send_email', label: 'Send Email' },
                        { id: 'noop', label: 'No-op Health' },
                        { id: 'custom', label: 'Custom' },
                      ] as const
                    ).map((h) => {
                      const isActive = form.handlerType === h.id;
                      return (
                        <button
                          key={h.id}
                          type="button"
                          aria-pressed={isActive}
                          onClick={() => {
                            setForm((prev) => ({
                              ...prev,
                              handlerType: h.id,
                              rawMode: h.id === 'custom' ? true : prev.rawMode,
                              rawPayload:
                                h.id === 'custom' &&
                                prev.rawPayload.trim() === ''
                                  ? DEFAULT_CUSTOM_PAYLOAD_EXAMPLE
                                  : prev.rawPayload,
                            }));
                            setValidationError(null);
                            setValidationField(null);
                          }}
                          className={cn(
                            'flex items-center justify-center rounded-md border py-1.5 text-xs font-medium transition-colors',
                            isActive
                              ? 'border-border-strong bg-surface-elevated text-text-primary font-semibold shadow-xs'
                              : 'border-border-subtle bg-surface-base text-text-muted hover:bg-surface-elevated/60 hover:text-text-primary',
                          )}
                        >
                          {h.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {form.handlerType === 'custom' && (
                  <div className="space-y-3.5 pt-1">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="custom-handler-name">
                          Custom Handler Name
                        </Label>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() =>
                            update('rawPayload', DEFAULT_CUSTOM_PAYLOAD_EXAMPLE)
                          }
                          className="text-text-muted hover:text-text-primary h-6 text-[0.6875rem]"
                        >
                          + Insert Sample Payload
                        </Button>
                      </div>
                      <Input
                        id="custom-handler-name"
                        value={form.customHandler}
                        onChange={(e) =>
                          update('customHandler', e.target.value)
                        }
                        placeholder="e.g. sync_inventory, generate_report, stripe_webhook"
                        className="bg-surface-base font-mono text-xs"
                        aria-invalid={validationField === 'customHandler'}
                        autoFocus
                      />
                      <p className="text-text-muted text-[0.6875rem]">
                        Must match a handler registered by a running worker in
                        your fleet.
                      </p>
                    </div>

                    {/* Custom Worker Guidance Card */}
                    <div className="border-border-subtle bg-surface-elevated/40 space-y-2.5 rounded-md border p-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <span className="text-text-primary text-xs font-semibold">
                            TypeScript Worker Snippet
                          </span>
                          <Badge
                            tone="info"
                            className="font-mono text-[0.625rem]"
                          >
                            @veyra/sdk
                          </Badge>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          onClick={(e) =>
                            handleCopy(workerSnippet, 'custom-worker-copy', e)
                          }
                          className="h-6 gap-1 text-[0.6875rem]"
                        >
                          <HugeiconsIcon
                            icon={
                              copiedKey === 'custom-worker-copy'
                                ? Tick01Icon
                                : Copy01Icon
                            }
                            className="h-3 w-3"
                          />
                          <span>
                            {copiedKey === 'custom-worker-copy'
                              ? 'Copied'
                              : 'Copy Code'}
                          </span>
                        </Button>
                      </div>

                      <p className="text-text-muted text-[0.6875rem] leading-relaxed">
                        External workers poll for jobs over HTTP with zero
                        database driver requirements. Install via{' '}
                        <code className="text-text-primary font-mono">
                          pnpm add @veyra/sdk
                        </code>{' '}
                        and authenticate with a key from{' '}
                        <Link
                          to="/settings/api-keys"
                          className="text-text-primary hover:text-text-secondary underline"
                        >
                          Settings → API Keys
                        </Link>
                        .
                      </p>

                      <div className="border-border-subtle bg-surface-base max-h-56 overflow-y-auto rounded-md border">
                        <CodeBlock language="text" defaultWrap>
                          {workerSnippet}
                        </CodeBlock>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Section 2: Guided Payload Authoring / Raw Mode */}
            <Card className="border-border-subtle bg-surface-base">
              <CardHeader className="border-border-subtle flex flex-row items-center justify-between border-b pb-2.5">
                <CardTitle className="text-text-primary flex items-center gap-1.5 font-medium">
                  <span>Job Payload</span>
                  <Badge tone="neutral" className="font-mono text-[0.625rem]">
                    {form.rawMode
                      ? 'JSON (Raw)'
                      : form.handlerType === 'http_request'
                        ? 'HTTP Builder'
                        : form.handlerType === 'send_email'
                          ? 'Email Builder'
                          : form.handlerType === 'noop'
                            ? 'No-op Builder'
                            : 'Custom JSON'}
                  </Badge>
                </CardTitle>
                {form.rawMode && (
                  <span className="text-text-muted text-[0.6875rem]">
                    Valid JSON required
                  </span>
                )}
              </CardHeader>
              <CardContent className="space-y-4 pt-3.5">
                {form.rawMode ? (
                  <div className="space-y-1.5">
                    <JsonEditor
                      value={form.rawPayload}
                      onChange={(v) => update('rawPayload', v)}
                      minHeight="240px"
                      aria-label="Raw JSON payload"
                      placeholder={'{\n  "key": "value"\n}'}
                    />
                    {effectivePayloadRes.error && (
                      <p
                        className="text-status-danger-text text-xs"
                        role="alert"
                      >
                        {effectivePayloadRes.error}
                      </p>
                    )}
                  </div>
                ) : form.handlerType === 'http_request' ? (
                  /* HTTP Request guided fields */
                  <div className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-4">
                      <div className="sm:col-span-1">
                        <Label htmlFor="http-method">Method</Label>
                        <select
                          id="http-method"
                          value={form.httpMethod}
                          onChange={(e) =>
                            update('httpMethod', e.target.value as HttpMethod)
                          }
                          className={selectClass}
                        >
                          {HTTP_METHODS.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="sm:col-span-3">
                        <Label htmlFor="http-url">Target URL</Label>
                        <Input
                          id="http-url"
                          type="url"
                          value={form.httpUrl}
                          onChange={(e) => update('httpUrl', e.target.value)}
                          placeholder="https://api.example.com/webhook"
                          className="font-mono text-xs"
                          aria-invalid={validationField === 'httpUrl'}
                          required
                          autoFocus
                        />
                      </div>
                    </div>

                    {/* Headers Builder */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label>HTTP Headers</Label>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={addHeader}
                          className="text-text-secondary text-[0.6875rem]"
                        >
                          + Add Header
                        </Button>
                      </div>
                      <div className="space-y-1.5">
                        {form.httpHeaders.map((header, idx) => (
                          <div key={idx} className="flex items-center gap-1.5">
                            <Input
                              aria-label={`Header ${idx + 1} Name`}
                              placeholder="Header Name"
                              value={header.key}
                              onChange={(e) =>
                                setHeader(idx, 'key', e.target.value)
                              }
                              className="font-mono text-xs"
                            />
                            <Input
                              aria-label={`Header ${idx + 1} Value`}
                              placeholder="Header Value"
                              value={header.value}
                              onChange={(e) =>
                                setHeader(idx, 'value', e.target.value)
                              }
                              className="font-mono text-xs"
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              onClick={() => removeHeader(idx)}
                              aria-label={`Remove header ${idx + 1}`}
                              className="text-text-muted hover:text-status-danger-text px-1.5"
                            >
                              ✕
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* HTTP Body Editor */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="http-body-editor">
                          JSON Body (Optional)
                        </Label>
                        {isBodylessHttp && (
                          <span className="text-status-warning-text text-[0.6875rem]">
                            Note: {form.httpMethod} usually has no body, but
                            Veyra will transmit it.
                          </span>
                        )}
                      </div>
                      <JsonEditor
                        value={form.httpBody}
                        onChange={handleHttpBodyChange}
                        placeholder={'{\n  "event": "ping"\n}'}
                        minHeight="140px"
                        aria-label="HTTP Body JSON"
                      />
                    </div>

                    {/* Timeout */}
                    <div className="space-y-1">
                      <Label htmlFor="http-timeout">
                        Request Timeout (seconds)
                      </Label>
                      <select
                        id="http-timeout"
                        value={String(form.httpTimeoutSeconds)}
                        onChange={(e) =>
                          update('httpTimeoutSeconds', Number(e.target.value))
                        }
                        className={selectClass}
                      >
                        {[5, 10, 15, 30, 45, 60, 120, 300].map((s) => (
                          <option key={s} value={s}>
                            {s} seconds
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                ) : form.handlerType === 'send_email' ? (
                  /* Send Email guided fields */
                  <div className="space-y-3.5">
                    <div className="space-y-1">
                      <Label htmlFor="email-to">To (Recipients)</Label>
                      <Input
                        id="email-to"
                        value={form.emailTo}
                        onChange={(e) => update('emailTo', e.target.value)}
                        placeholder="operator@example.com (comma-separated for multiple)"
                        aria-invalid={validationField === 'emailTo'}
                        required
                        autoFocus
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label htmlFor="email-from">
                          From Address (Optional)
                        </Label>
                        <Input
                          id="email-from"
                          value={form.emailFrom}
                          onChange={(e) => update('emailFrom', e.target.value)}
                          placeholder="Default worker VEYRA_SMTP_FROM"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="email-reply-to">
                          Reply-To (Optional)
                        </Label>
                        <Input
                          id="email-reply-to"
                          value={form.emailReplyTo}
                          onChange={(e) =>
                            update('emailReplyTo', e.target.value)
                          }
                          placeholder="support@example.com"
                        />
                      </div>
                    </div>

                    <div className="space-y-1">
                      <Label htmlFor="email-subject">Subject</Label>
                      <Input
                        id="email-subject"
                        value={form.emailSubject}
                        onChange={(e) => update('emailSubject', e.target.value)}
                        placeholder="Operational Alert Subject"
                        aria-invalid={validationField === 'emailSubject'}
                        required
                      />
                    </div>

                    <div className="space-y-1">
                      <Label htmlFor="email-text">Plain-Text Body</Label>
                      <Textarea
                        id="email-text"
                        rows={3}
                        value={form.emailText}
                        onChange={(e) => update('emailText', e.target.value)}
                        placeholder="Notification text..."
                      />
                    </div>

                    <div className="space-y-1">
                      <Label htmlFor="email-html">HTML Body (Optional)</Label>
                      <Textarea
                        id="email-html"
                        rows={3}
                        value={form.emailHtml}
                        onChange={(e) => update('emailHtml', e.target.value)}
                        placeholder="<p>Formatted HTML content...</p>"
                        className="font-mono text-xs"
                      />
                    </div>
                  </div>
                ) : (
                  /* No-op Health Check guided fields */
                  <div className="space-y-3.5">
                    <div className="space-y-1">
                      <Label htmlFor="noop-message">Diagnostic Message</Label>
                      <Input
                        id="noop-message"
                        value={form.noopMessage}
                        onChange={(e) => update('noopMessage', e.target.value)}
                        placeholder="Queue verification check"
                        autoFocus
                      />
                    </div>

                    <div className="space-y-1">
                      <Label htmlFor="noop-delay">
                        Simulated Worker Delay (ms)
                      </Label>
                      <Input
                        id="noop-delay"
                        type="number"
                        min={0}
                        max={10000}
                        step={50}
                        value={form.noopSimulatedDelayMs}
                        onChange={(e) =>
                          update(
                            'noopSimulatedDelayMs',
                            Math.max(0, Number(e.target.value)),
                          )
                        }
                        className="font-mono text-xs tabular-nums"
                      />
                      <p className="text-text-muted text-[0.6875rem]">
                        Worker sleeps for this duration before succeeding.
                      </p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Section 3: Queue & Worker Routing */}
            <Card className="border-border-subtle bg-surface-base">
              <CardHeader className="border-border-subtle flex flex-row items-center justify-between border-b pb-2.5">
                <CardTitle className="text-text-primary flex items-center gap-1.5 font-medium">
                  <HugeiconsIcon
                    icon={ServerStack01Icon}
                    className="h-3.5 w-3.5"
                  />
                  <span>Queue & Worker Routing</span>
                </CardTitle>
                <div className="flex items-center gap-1.5">
                  <span className="text-text-muted text-[0.6875rem]">
                    Active Queues ({availableQueues.length}):
                  </span>
                  {availableQueues.slice(0, 3).map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => update('queue', q)}
                      className={cn(
                        'rounded-xs border px-1.5 py-0.5 font-mono text-[0.625rem] transition-colors',
                        form.queue === q
                          ? 'border-border-strong bg-surface-elevated text-text-primary font-medium'
                          : 'border-border-subtle bg-surface-base text-text-muted hover:text-text-primary',
                      )}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </CardHeader>
              <CardContent className="space-y-3 pt-3.5">
                <div className="space-y-1">
                  <Label htmlFor="queue-name-input">Target Queue Name</Label>
                  <Input
                    id="queue-name-input"
                    list="available-queues-list"
                    value={form.queue}
                    onChange={(e) => update('queue', e.target.value)}
                    placeholder="default"
                    className="font-mono text-xs"
                    aria-invalid={validationField === 'queue'}
                    required
                  />
                  <datalist id="available-queues-list">
                    {availableQueues.map((q) => (
                      <option key={q} value={q} />
                    ))}
                  </datalist>
                </div>
              </CardContent>
            </Card>

            {/* Section 4: Execution Policy, Retry & Backoff */}
            <Card className="border-border-subtle bg-surface-base">
              <CardHeader className="border-border-subtle flex flex-row items-center justify-between border-b pb-2.5">
                <CardTitle className="text-text-primary flex items-center gap-1.5 font-medium">
                  <HugeiconsIcon icon={Refresh01Icon} className="h-3.5 w-3.5" />
                  <span>Execution Policy & Retry Backoff</span>
                </CardTitle>
                <Badge tone="neutral" className="text-[0.625rem] tabular-nums">
                  P{form.priority} • {form.maxAttempts}{' '}
                  {form.maxAttempts === 1 ? 'Attempt' : 'Attempts'}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-4 pt-3.5">
                {/* Priority Selector (0-9) */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="job-priority">
                      Job Priority (0 = lowest, 9 = highest)
                    </Label>
                    <span className="font-mono text-xs font-semibold tabular-nums">
                      {form.priority}{' '}
                      <span className="text-text-muted font-normal">
                        {form.priority >= 8
                          ? '(High / Critical)'
                          : form.priority <= 3
                            ? '(Low)'
                            : '(Normal)'}
                      </span>
                    </span>
                  </div>
                  <div
                    className="grid grid-cols-10 gap-1"
                    role="radiogroup"
                    aria-label="Job Priority"
                  >
                    {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((p) => {
                      const selected = form.priority === p;
                      return (
                        <button
                          key={p}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => update('priority', p)}
                          className={cn(
                            'flex h-7 items-center justify-center rounded-sm border font-mono text-xs tabular-nums transition-colors',
                            selected
                              ? p >= 8
                                ? 'border-status-danger-border bg-status-danger-bg text-status-danger-text font-bold'
                                : p <= 3
                                  ? 'border-status-neutral-border bg-surface-elevated text-text-primary font-bold'
                                  : 'border-border-strong bg-surface-elevated text-text-primary font-bold'
                              : 'border-border-subtle bg-surface-base text-text-muted hover:bg-surface-elevated hover:text-text-primary',
                          )}
                        >
                          {p}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Retry Attempts and Backoff Mode */}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="max-attempts">Max Retry Attempts</Label>
                    <Input
                      id="max-attempts"
                      type="number"
                      min={1}
                      max={20}
                      value={form.maxAttempts}
                      onChange={(e) =>
                        update(
                          'maxAttempts',
                          Math.max(1, Number(e.target.value)),
                        )
                      }
                      className="font-mono text-xs tabular-nums"
                      aria-invalid={validationField === 'maxAttempts'}
                      required
                    />
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="backoff-preset">
                      Backoff Strategy Preset
                    </Label>
                    <select
                      id="backoff-preset"
                      value={form.backoffPreset}
                      onChange={(e) =>
                        handleBackoffPresetSelect(
                          e.target.value as BackoffPresetId,
                        )
                      }
                      className={selectClass}
                    >
                      {BACKOFF_PRESETS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                      <option value="custom">Custom Configuration...</option>
                    </select>
                  </div>
                </div>

                {/* Backoff Strategy Detailed Controls */}
                <div className="border-border-subtle bg-surface-elevated/40 space-y-3 rounded-md border p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-text-primary text-xs font-medium">
                      Backoff Parameters
                    </span>
                    <span className="text-text-muted font-mono text-[0.625rem]">
                      SPEC §3.5.2 (Uniform Jitter [0.5, 1.5))
                    </span>
                  </div>

                  <div className="flex gap-4 text-xs">
                    <label className="text-text-secondary flex cursor-pointer items-center gap-1.5 select-none">
                      <input
                        type="radio"
                        name="backoffKind"
                        checked={form.backoffKind === 'exponential'}
                        onChange={() => {
                          update('backoffKind', 'exponential');
                          update('backoffPreset', 'custom');
                        }}
                        className="text-primary accent-primary"
                      />
                      <span>Exponential (base × 2^(attempt-1))</span>
                    </label>
                    <label className="text-text-secondary flex cursor-pointer items-center gap-1.5 select-none">
                      <input
                        type="radio"
                        name="backoffKind"
                        checked={form.backoffKind === 'fixed'}
                        onChange={() => {
                          update('backoffKind', 'fixed');
                          update('backoffPreset', 'custom');
                        }}
                        className="text-primary accent-primary"
                      />
                      <span>Fixed Delay</span>
                    </label>
                  </div>

                  {form.backoffKind === 'exponential' ? (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label
                          htmlFor="backoff-base-seconds"
                          className="text-[0.6875rem]"
                        >
                          Base Seconds
                        </Label>
                        <Input
                          id="backoff-base-seconds"
                          type="number"
                          min={1}
                          max={86400}
                          value={form.backoffBaseSeconds}
                          onChange={(e) => {
                            update(
                              'backoffBaseSeconds',
                              Math.max(1, Number(e.target.value)),
                            );
                            update('backoffPreset', 'custom');
                          }}
                          className="bg-surface-base font-mono text-xs tabular-nums"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label
                          htmlFor="backoff-cap-seconds"
                          className="text-[0.6875rem]"
                        >
                          Cap Ceiling (Seconds)
                        </Label>
                        <Input
                          id="backoff-cap-seconds"
                          type="number"
                          min={1}
                          max={604800}
                          value={form.backoffCapSeconds}
                          onChange={(e) => {
                            update(
                              'backoffCapSeconds',
                              Math.max(1, Number(e.target.value)),
                            );
                            update('backoffPreset', 'custom');
                          }}
                          className="bg-surface-base font-mono text-xs tabular-nums"
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <Label
                        htmlFor="backoff-fixed-seconds"
                        className="text-[0.6875rem]"
                      >
                        Fixed Delay (Seconds)
                      </Label>
                      <Input
                        id="backoff-fixed-seconds"
                        type="number"
                        min={1}
                        max={86400}
                        value={form.backoffFixedSeconds}
                        onChange={(e) => {
                          update(
                            'backoffFixedSeconds',
                            Math.max(1, Number(e.target.value)),
                          );
                          update('backoffPreset', 'custom');
                        }}
                        className="bg-surface-base font-mono text-xs tabular-nums"
                      />
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Section 5: Scheduling & Delayed Execution */}
            <Card className="border-border-subtle bg-surface-base">
              <CardHeader className="border-border-subtle flex flex-row items-center justify-between border-b pb-2.5">
                <CardTitle className="text-text-primary flex items-center gap-1.5 font-medium">
                  <HugeiconsIcon icon={Clock01Icon} className="h-3.5 w-3.5" />
                  <span>Execution Schedule</span>
                </CardTitle>
                <div className="flex items-center gap-1">
                  {[
                    { label: 'Now', mins: 0 },
                    { label: '+1m', mins: 1 },
                    { label: '+5m', mins: 5 },
                    { label: '+15m', mins: 15 },
                    { label: '+1h', mins: 60 },
                    { label: '+24h', mins: 1440 },
                  ].map((chip) => (
                    <button
                      key={chip.label}
                      type="button"
                      onClick={() => handleScheduleOffset(chip.mins)}
                      className="border-border-subtle bg-surface-base text-text-muted hover:bg-surface-elevated hover:text-text-primary rounded-xs border px-1.5 py-0.5 font-mono text-[0.625rem] transition-colors"
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>
              </CardHeader>
              <CardContent className="space-y-2 pt-3.5">
                <div className="space-y-1">
                  <Label htmlFor="scheduled-for-input">
                    Run At / Scheduled Time (Optional)
                  </Label>
                  <Input
                    id="scheduled-for-input"
                    type="datetime-local"
                    value={form.scheduledFor}
                    onChange={(e) => update('scheduledFor', e.target.value)}
                    className="font-mono text-xs"
                    aria-invalid={validationField === 'scheduledFor'}
                  />
                </div>
                <p className="text-text-muted text-[0.6875rem]">
                  Jobs scheduled in the future are placed in the{' '}
                  <span className="font-mono">scheduled</span> state until the
                  background retry/reclaim scheduler promotes them to{' '}
                  <span className="font-mono">queued</span>.
                </p>
              </CardContent>
            </Card>
          </div>

          {/* ======================================================== */}
          {/* RIGHT COLUMN: Operational Context, Preview, & Dispatch */}
          {/* ======================================================== */}
          <div className="space-y-5 lg:col-span-5">
            {/* Card 1: Target Queue & Worker Fleet Readiness Signal */}
            <Card
              className={cn(
                'border',
                readiness.status === 'healthy' || readiness.status === 'loading'
                  ? 'border-border-subtle bg-surface-base'
                  : 'border-status-warning-border bg-status-warning-bg/15',
              )}
            >
              <CardHeader className="border-border-subtle flex flex-row items-center justify-between border-b pb-2.5">
                <CardTitle className="text-text-primary flex items-center gap-1.5 font-medium">
                  <HugeiconsIcon
                    icon={ServerStack01Icon}
                    className="h-3.5 w-3.5"
                  />
                  <span>Worker Fleet Readiness</span>
                </CardTitle>
                <Badge
                  tone={
                    readiness.status === 'healthy'
                      ? 'success'
                      : readiness.status === 'unserviced'
                        ? 'warning'
                        : readiness.status === 'loading'
                          ? 'neutral'
                          : 'danger'
                  }
                >
                  {readiness.status === 'healthy'
                    ? 'Active Workers Ready'
                    : readiness.status === 'unserviced'
                      ? 'No Workers on Queue'
                      : readiness.status === 'loading'
                        ? 'Checking Fleet...'
                        : '0 Fleet Workers'}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-3 pt-3.5 text-xs">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="border-border-subtle bg-surface-elevated/40 rounded-md border p-2">
                    <span className="text-text-muted block text-[0.625rem]">
                      Queue Depth
                    </span>
                    <span className="text-text-primary font-mono text-sm font-semibold tabular-nums">
                      {readiness.queueDepth}
                    </span>
                  </div>
                  <div className="border-border-subtle bg-surface-elevated/40 rounded-md border p-2">
                    <span className="text-text-muted block text-[0.625rem]">
                      Queue Workers
                    </span>
                    <span className="text-text-primary font-mono text-sm font-semibold tabular-nums">
                      {readiness.queueWorkers}
                    </span>
                  </div>
                  <div className="border-border-subtle bg-surface-elevated/40 rounded-md border p-2">
                    <span className="text-text-muted block text-[0.625rem]">
                      Matching Handler
                    </span>
                    <span
                      className={cn(
                        'font-mono text-sm font-semibold tabular-nums',
                        readiness.handlerWorkers > 0
                          ? 'text-status-success-text'
                          : 'text-status-danger-text',
                      )}
                    >
                      {readiness.handlerWorkers}
                    </span>
                  </div>
                </div>

                {readiness.warning && (
                  <div
                    role="alert"
                    className="border-status-warning-border bg-status-warning-bg/40 text-status-warning-text flex items-start gap-2 rounded-md border p-2.5 text-xs"
                  >
                    <HugeiconsIcon
                      icon={Alert02Icon}
                      className="mt-0.5 h-4 w-4 shrink-0"
                    />
                    <div className="space-y-1">
                      <span className="block font-medium">
                        Dispatch Readiness Warning
                      </span>
                      <p className="text-[0.6875rem] leading-snug">
                        {readiness.warning}
                      </p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Card 2: Idempotency & Delivery Guarantees */}
            <Card className="border-border-subtle bg-surface-base">
              <CardHeader className="border-border-subtle flex flex-row items-center justify-between border-b pb-2.5">
                <CardTitle className="text-text-primary flex items-center gap-1.5 font-medium">
                  <HugeiconsIcon icon={Key01Icon} className="h-3.5 w-3.5" />
                  <span>Idempotency & Delivery Guarantees</span>
                </CardTitle>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => handleGenerateKey('ulid')}
                    className="font-mono text-[0.625rem]"
                  >
                    + ULID
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => handleGenerateKey('uuid')}
                    className="font-mono text-[0.625rem]"
                  >
                    + UUID
                  </Button>
                  {form.idempotencyKey && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => update('idempotencyKey', '')}
                      className="text-text-muted hover:text-text-primary px-1.5 text-[0.625rem]"
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-2.5 pt-3.5">
                <div className="space-y-1">
                  <Label htmlFor="idempotency-key-input">
                    Idempotency Key (Optional)
                  </Label>
                  <Input
                    id="idempotency-key-input"
                    value={form.idempotencyKey}
                    onChange={(e) => update('idempotencyKey', e.target.value)}
                    placeholder="e.g. ord_checkout_99182 or ulid"
                    className="font-mono text-xs"
                  />
                </div>
                <div className="border-border-subtle bg-surface-elevated/40 space-y-1 rounded-md border p-2 text-[0.6875rem]">
                  <p className="text-text-secondary">
                    Transmitted via both{' '}
                    <code className="font-mono">Idempotency-Key</code> header
                    and payload body.
                  </p>
                  <p className="text-text-muted leading-tight">
                    • Identical key + params ={' '}
                    <span className="text-text-primary font-semibold">
                      201 Replay
                    </span>{' '}
                    (returns existing job).
                    <br />• Identical key + changed params ={' '}
                    <span className="text-status-danger-text font-semibold">
                      409 Conflict
                    </span>
                    .
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Card 3: Live Request & cURL Preview */}
            <Card className="border-border-subtle bg-surface-base">
              <CardHeader className="border-border-subtle flex flex-row items-center justify-between border-b pb-2.5">
                <CardTitle className="text-text-primary flex items-center gap-1.5 font-medium">
                  <HugeiconsIcon icon={ViewIcon} className="h-3.5 w-3.5" />
                  <span>Live Dispatch Preview</span>
                </CardTitle>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setPreviewTab('payload')}
                    className={cn(
                      'rounded-xs border px-2 py-0.5 text-xs font-medium transition-colors',
                      previewTab === 'payload'
                        ? 'border-border-strong bg-surface-elevated text-text-primary font-semibold'
                        : 'border-border-subtle bg-surface-base text-text-muted hover:text-text-primary',
                    )}
                  >
                    JSON
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewTab('curl')}
                    className={cn(
                      'rounded-xs border px-2 py-0.5 text-xs font-medium transition-colors',
                      previewTab === 'curl'
                        ? 'border-border-strong bg-surface-elevated text-text-primary font-semibold'
                        : 'border-border-subtle bg-surface-base text-text-muted hover:text-text-primary',
                    )}
                  >
                    cURL
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewTab('worker')}
                    className={cn(
                      'rounded-xs border px-2 py-0.5 text-xs font-medium transition-colors',
                      previewTab === 'worker'
                        ? 'border-border-strong bg-surface-elevated text-text-primary font-semibold'
                        : 'border-border-subtle bg-surface-base text-text-muted hover:text-text-primary',
                    )}
                  >
                    Worker SDK
                  </button>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 pt-3.5">
                {previewTab === 'payload' ? (
                  <CodeBlock language="json" defaultWrap>
                    {JSON.stringify(parsedForCurl.payload ?? {}, null, 2)}
                  </CodeBlock>
                ) : previewTab === 'curl' ? (
                  <CodeBlock language="text" defaultWrap>
                    {curlSnippet}
                  </CodeBlock>
                ) : (
                  <CodeBlock language="text" defaultWrap>
                    {workerSnippet}
                  </CodeBlock>
                )}
              </CardContent>
            </Card>

            {/* Card 4: Dispatch Summary & Operational Actions */}
            <Card className="border-border-strong bg-surface-base">
              <CardHeader className="border-border-subtle flex flex-row items-center justify-between border-b pb-2.5">
                <CardTitle className="text-text-primary font-medium">
                  Dispatch Confirmation
                </CardTitle>
                <Badge tone="info" className="font-mono text-[0.625rem]">
                  POST /jobs
                </Badge>
              </CardHeader>
              <CardContent className="space-y-4 pt-3.5">
                {/* Summary Badges */}
                <div className="flex flex-wrap gap-1.5 text-xs">
                  <Badge tone="neutral">
                    handler:{' '}
                    <span className="font-mono font-bold">
                      {effectiveHandler || '—'}
                    </span>
                  </Badge>
                  <Badge tone="neutral">
                    queue:{' '}
                    <span className="font-mono font-bold">{form.queue}</span>
                  </Badge>
                  <Badge tone="neutral">
                    prio:{' '}
                    <span className="font-mono font-bold tabular-nums">
                      {form.priority}
                    </span>
                  </Badge>
                  <Badge tone="neutral">
                    attempts:{' '}
                    <span className="font-mono font-bold tabular-nums">
                      {form.maxAttempts}
                    </span>
                  </Badge>
                  <Badge tone="neutral">
                    run:{' '}
                    <span className="font-mono font-bold">
                      {form.scheduledFor ? 'scheduled' : 'immediate'}
                    </span>
                  </Badge>
                </div>

                {/* Validation and Error Alerts */}
                {validationError && (
                  <div
                    role="alert"
                    className="border-status-danger-border bg-status-danger-bg/40 text-status-danger-text flex items-start gap-2 rounded-md border p-2.5 text-xs"
                  >
                    <HugeiconsIcon
                      icon={Alert02Icon}
                      className="mt-0.5 h-4 w-4 shrink-0"
                    />
                    <div className="space-y-1">
                      <span className="block font-medium">
                        Validation Error
                      </span>
                      <p className="text-[0.6875rem] leading-snug">
                        {validationError}
                      </p>
                    </div>
                  </div>
                )}

                {/* Idempotency Conflict Alert with 1-Click Fix */}
                {idempotencyConflict && (
                  <div
                    role="alert"
                    className="border-status-danger-border bg-status-danger-bg/60 text-status-danger-text space-y-2 rounded-md border p-3 text-xs"
                  >
                    <div className="flex items-start gap-2">
                      <HugeiconsIcon
                        icon={Alert02Icon}
                        className="text-status-danger-solid mt-0.5 h-4 w-4 shrink-0"
                      />
                      <div>
                        <span className="block font-semibold">
                          409 Conflict: Idempotency Key Mismatch
                        </span>
                        <p className="mt-0.5 text-[0.6875rem] leading-snug">
                          A job already exists with key{' '}
                          <code className="font-mono font-bold">
                            {idempotencyConflict.key}
                          </code>{' '}
                          but with different parameters or payload. Veyra
                          strictly forbids mutating existing idempotency keys.
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 pt-1">
                      <Button
                        type="button"
                        size="xs"
                        variant="destructive"
                        onClick={handleRetryWithNewKey}
                        className="text-[0.6875rem]"
                      >
                        Generate New Key & Dispatch
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => setIdempotencyConflict(null)}
                        className="text-[0.6875rem]"
                      >
                        Dismiss
                      </Button>
                    </div>
                  </div>
                )}

                {/* Advanced Dispatch Features */}
                <div className="border-border-subtle bg-surface-elevated/20 flex flex-col gap-2 rounded-md border p-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-text-muted text-[0.625rem] font-medium tracking-wide uppercase">
                      Advanced Dispatch Features
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={handleDryRun}
                      disabled={dryRunMutation.isPending || mutation.isPending}
                      className="gap-1.5"
                      title="Validate payload against server enqueue rules without persisting a job"
                    >
                      {dryRunMutation.isPending ? (
                        <HugeiconsIcon
                          icon={Refresh01Icon}
                          className="h-3 w-3 animate-spin"
                        />
                      ) : (
                        <HugeiconsIcon icon={Tick01Icon} className="h-3 w-3" />
                      )}
                      <span>Dry-run Validate</span>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled
                      className="cursor-not-allowed opacity-50"
                      title="Requires backend dispatch template registry"
                    >
                      Save as Template
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled
                      className="cursor-not-allowed opacity-50"
                      title="Requires backend batch enqueue endpoint POST /jobs/batch"
                    >
                      Bulk Batch Enqueue
                    </Button>
                  </div>
                </div>

                {/* Dry-Run Validation Outcome Banner */}
                {dryRunResult && (
                  <div
                    role="region"
                    aria-label="Dry-run Validation Result"
                    className={cn(
                      'flex items-start gap-2.5 rounded-md border p-3 text-xs transition-all',
                      dryRunResult.valid
                        ? 'border-status-success-border bg-status-success-bg/30 text-text-primary'
                        : 'border-status-danger-border bg-status-danger-bg/30 text-text-primary',
                    )}
                  >
                    <div
                      className={cn(
                        'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
                        dryRunResult.valid
                          ? 'bg-status-success-solid text-white'
                          : 'bg-status-danger-solid text-white',
                      )}
                    >
                      <HugeiconsIcon
                        icon={dryRunResult.valid ? Tick01Icon : Alert02Icon}
                        className="h-3 w-3"
                      />
                    </div>
                    <div className="flex-1 space-y-0.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-semibold">
                          {dryRunResult.valid
                            ? 'Payload Dry-Run Valid'
                            : 'Validation Failed'}
                        </span>
                        <Badge
                          tone={dryRunResult.valid ? 'success' : 'danger'}
                          className="font-mono text-[0.625rem]"
                        >
                          {dryRunResult.valid ? '200 OK' : '400 Bad Request'}
                        </Badge>
                      </div>
                      <p className="text-text-muted text-[0.6875rem]">
                        {dryRunResult.valid
                          ? 'Payload passes all server-side validation rules (handler, queue, payload JSON, priority, backoff, and idempotency key format).'
                          : dryRunResult.error ||
                            'Server rejected payload parameters.'}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => setDryRunResult(null)}
                      className="text-text-muted hover:text-text-primary h-6 px-1.5 text-[0.625rem]"
                    >
                      Dismiss
                    </Button>
                  </div>
                )}

                {/* Primary Dispatch Action */}
                <div className="space-y-2 pt-1">
                  <Button
                    type="submit"
                    className="h-9 w-full font-medium"
                    disabled={mutation.isPending}
                  >
                    {mutation.isPending ? (
                      <span className="flex items-center gap-2">
                        <HugeiconsIcon
                          icon={Refresh01Icon}
                          className="h-4 w-4 animate-spin"
                        />
                        <span>Dispatching to PostgreSQL...</span>
                      </span>
                    ) : (
                      <span className="flex items-center justify-center gap-1.5">
                        <span>Dispatch Job</span>
                        <HugeiconsIcon
                          icon={ArrowRight01Icon}
                          className="h-3.5 w-3.5"
                        />
                      </span>
                    )}
                  </Button>
                  <p className="text-text-muted text-center text-[0.6875rem]">
                    Press{' '}
                    <kbd className="border-border-strong bg-surface-elevated rounded-xs border px-1 py-0.5 font-mono text-[0.625rem]">
                      ⌘ + Enter
                    </kbd>{' '}
                    or{' '}
                    <kbd className="border-border-strong bg-surface-elevated rounded-xs border px-1 py-0.5 font-mono text-[0.625rem]">
                      Ctrl + Enter
                    </kbd>{' '}
                    to dispatch immediately.
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Card 5: Post-Submission Outcome Banner */}
            {submissionSuccess && (
              <div
                role="region"
                aria-label="Job Dispatch Confirmation"
                className={cn(
                  'space-y-3 rounded-lg border p-4 shadow-sm transition-all',
                  submissionSuccess.isReplay
                    ? 'border-status-info-border bg-status-info-bg/30 text-text-primary'
                    : 'border-status-success-border bg-status-success-bg/30 text-text-primary',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div
                      className={cn(
                        'flex h-7 w-7 items-center justify-center rounded-full',
                        submissionSuccess.isReplay
                          ? 'bg-status-info-solid text-white'
                          : 'bg-status-success-solid text-white',
                      )}
                    >
                      <HugeiconsIcon icon={Tick01Icon} className="h-4 w-4" />
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-semibold">
                          {submissionSuccess.isReplay
                            ? 'Idempotent Replay Verified'
                            : 'Job Successfully Dispatched'}
                        </span>
                        <Badge
                          tone={submissionSuccess.isReplay ? 'info' : 'success'}
                          className="font-mono text-[0.625rem]"
                        >
                          {submissionSuccess.isReplay
                            ? '201 Replay'
                            : '201 Created'}
                        </Badge>
                      </div>
                      <p className="text-text-muted text-[0.6875rem]">
                        {submissionSuccess.isReplay
                          ? 'Existing job retrieved matching idempotency fingerprint.'
                          : 'Job persisted to queue and ready for worker claim.'}
                      </p>
                    </div>
                  </div>
                  <StatusBadge status={submissionSuccess.status} />
                </div>

                <div className="border-border-subtle bg-surface-base/90 flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-text-muted text-[0.6875rem]">
                      Job ID:
                    </span>
                    <span className="font-mono font-semibold tabular-nums">
                      {submissionSuccess.id}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={(e) =>
                      handleCopy(submissionSuccess.id, 'job-id-copy', e)
                    }
                    className="h-6 gap-1 px-2 text-[0.6875rem]"
                  >
                    <HugeiconsIcon
                      icon={
                        copiedKey === 'job-id-copy' ? Tick01Icon : Copy01Icon
                      }
                      className="h-3 w-3"
                    />
                    <span>
                      {copiedKey === 'job-id-copy' ? 'Copied' : 'Copy ID'}
                    </span>
                  </Button>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() =>
                      navigate(jobDetailPath(submissionSuccess.id))
                    }
                    className="gap-1.5 text-xs"
                  >
                    <span>Inspect Job</span>
                    <HugeiconsIcon
                      icon={ArrowRight01Icon}
                      className="h-3.5 w-3.5"
                    />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSubmissionSuccess(null);
                      handleGenerateKey('ulid');
                    }}
                    className="text-xs"
                  >
                    Dispatch Another
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setSubmissionSuccess(null)}
                    className="text-text-muted text-xs"
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
