import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { CodeBlock } from '@/components/ui/code-block';
import { Input } from '@/components/ui/input';
import { JsonEditor } from '@/components/ui/json-editor';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useEnqueueJob } from '@/hooks/api';
import { ApiError } from '@/lib/api/client';
import type { EnqueueJobInput } from '@/lib/api/jobs';
import { jobDetailPath } from '@/lib/routes';
import { cn } from '@/lib/utils';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];
type JobKind = 'http' | 'email';

const selectClass =
  'border-border h-9 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30';

const BODYLESS_METHODS = new Set<HttpMethod>(['GET', 'HEAD']);

interface HeaderRow {
  key: string;
  value: string;
}

interface FormState {
  jobKind: JobKind;
  // http_request
  url: string;
  method: HttpMethod;
  headers: HeaderRow[];
  body: string;
  timeoutSeconds: string;
  // send_email
  emailTo: string;
  emailFrom: string;
  emailSubject: string;
  emailText: string;
  emailHtml: string;
  emailReplyTo: string;
  // shared job knobs
  maxAttempts: string;
  queue: string;
  priority: string;
  scheduledFor: string;
  idempotencyKey: string;
  rawMode: boolean;
  rawPayload: string;
}

const INITIAL_FORM: FormState = {
  jobKind: 'http',
  url: '',
  method: 'POST',
  headers: [{ key: '', value: '' }],
  body: '',
  timeoutSeconds: '30',
  emailTo: '',
  emailFrom: '',
  emailSubject: '',
  emailText: '',
  emailHtml: '',
  emailReplyTo: '',
  maxAttempts: '3',
  queue: 'default',
  priority: '5',
  scheduledFor: '',
  idempotencyKey: '',
  rawMode: false,
  rawPayload: '',
};

const HTTP_EXAMPLES: { label: string; patch: Partial<FormState> }[] = [
  {
    label: 'GET httpbin.org/get',
    patch: {
      method: 'GET',
      url: 'https://httpbin.org/get',
      headers: [{ key: '', value: '' }],
      body: '',
    },
  },
  {
    label: 'POST httpbin.org/post',
    patch: {
      method: 'POST',
      url: 'https://httpbin.org/post',
      headers: [{ key: 'Content-Type', value: 'application/json' }],
      body: '{\n  "hello": "veyra"\n}',
    },
  },
];

const EMAIL_EXAMPLES: { label: string; patch: Partial<FormState> }[] = [
  {
    label: 'Sample email',
    patch: {
      emailTo: 'you@example.com',
      emailFrom: '',
      emailSubject: 'Hello from Veyra',
      emailText: 'This email was sent by a Veyra send_email job.',
      emailHtml: '',
      emailReplyTo: '',
    },
  },
];

export function EnqueuePage() {
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const mutation = useEnqueueJob({
    onSuccess: (job) => navigate(jobDetailPath(job.id)),
  });

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const setJobKind = (jobKind: JobKind) => {
    setValidationError(null);
    setForm((prev) => ({ ...prev, jobKind, rawMode: false, rawPayload: '' }));
  };

  const applyExample = (patch: Partial<FormState>) => {
    setValidationError(null);
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const setHeader = (i: number, field: keyof HeaderRow, value: string) =>
    setForm((prev) => {
      const headers = prev.headers.map((h, idx) =>
        idx === i ? { ...h, [field]: value } : h,
      );
      return { ...prev, headers };
    });

  const addHeader = () =>
    setForm((prev) => ({
      ...prev,
      headers: [...prev.headers, { key: '', value: '' }],
    }));

  const removeHeader = (i: number) =>
    setForm((prev) => {
      const headers = prev.headers.filter((_, idx) => idx !== i);
      return {
        ...prev,
        headers: headers.length ? headers : [{ key: '', value: '' }],
      };
    });

  const setBody = (body: string) => {
    setForm((prev) => {
      let headers = prev.headers;
      if (body.trim() !== '' && !hasContentType(headers)) {
        headers = ensureContentType(headers, 'application/json');
      }
      return { ...prev, body, headers };
    });
  };

  const toggleRawMode = () =>
    setForm((prev) => {
      const rawMode = !prev.rawMode;
      const rawPayload =
        rawMode && prev.rawPayload.trim() === ''
          ? JSON.stringify(
              prev.jobKind === 'email'
                ? buildEmailPayload(prev)
                : buildHttpPayload(prev),
              null,
              2,
            )
          : prev.rawPayload;
      return { ...prev, rawMode, rawPayload };
    });

  const handleSubmit = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    setValidationError(null);

    const result = parseForm(form);
    if ('error' in result) {
      setValidationError(result.error);
      if (result.advanced) setAdvancedOpen(true);
      return;
    }
    mutation.mutate(result.value);
  };

  const serverError =
    mutation.error instanceof ApiError
      ? mutation.error.message
      : mutation.error
        ? String(mutation.error)
        : null;

  const showBodyNote =
    form.jobKind === 'http' &&
    BODYLESS_METHODS.has(form.method) &&
    form.body.trim() !== '';
  const generatedPayload = JSON.stringify(
    form.jobKind === 'email' ? buildEmailPayload(form) : buildHttpPayload(form),
    null,
    2,
  );
  const examples = form.jobKind === 'email' ? EMAIL_EXAMPLES : HTTP_EXAMPLES;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Create job</h2>
          <p className="text-muted-foreground text-xs">
            {form.jobKind === 'email'
              ? 'Enqueue an email. The worker sends it over SMTP.'
              : 'Build a request. Veyra runs it and keeps the result.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {examples.map((ex) => (
            <Button
              key={ex.label}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => applyExample(ex.patch)}
            >
              {ex.label}
            </Button>
          ))}
        </div>
      </div>

      <Card>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4 pt-4">
            <div className="space-y-1.5">
              <Label>Job type</Label>
              <div
                className="flex flex-wrap gap-1.5"
                role="group"
                aria-label="Job type"
              >
                {(
                  [
                    { id: 'http', label: 'HTTP request' },
                    { id: 'email', label: 'Email' },
                  ] as const
                ).map((opt) => {
                  const on = form.jobKind === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setJobKind(opt.id)}
                      className={cn(
                        'rounded-md border px-2.5 py-1 text-[0.6875rem] font-medium transition-colors',
                        on
                          ? 'border-foreground/20 bg-foreground text-background'
                          : 'border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                      )}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {form.jobKind === 'http' ? (
              <>
                <Row>
                  <div className="sm:max-w-[8.5rem]">
                    <Field label="Method" htmlFor="method">
                      <select
                        id="method"
                        value={form.method}
                        onChange={(e) =>
                          update('method', e.target.value as HttpMethod)
                        }
                        className={selectClass}
                      >
                        {HTTP_METHODS.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <Field label="URL" htmlFor="url">
                    <Input
                      id="url"
                      value={form.url}
                      onChange={(e) => update('url', e.target.value)}
                      placeholder="https://api.example.com/webhook"
                      required={form.jobKind === 'http'}
                      autoFocus
                    />
                  </Field>
                </Row>

                <div className="space-y-2">
                  <Label>Headers</Label>
                  <div className="space-y-2">
                    {form.headers.map((h, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Input
                          aria-label={`Header ${i + 1} name`}
                          value={h.key}
                          onChange={(e) => setHeader(i, 'key', e.target.value)}
                          placeholder="Header"
                          className="flex-1"
                        />
                        <Input
                          aria-label={`Header ${i + 1} value`}
                          value={h.value}
                          onChange={(e) =>
                            setHeader(i, 'value', e.target.value)
                          }
                          placeholder="Value"
                          className="flex-1"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeHeader(i)}
                          aria-label={`Remove header ${i + 1}`}
                        >
                          ✕
                        </Button>
                      </div>
                    ))}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addHeader}
                  >
                    + Add header
                  </Button>
                </div>

                <div className="space-y-2">
                  <Label>Body</Label>
                  <JsonEditor
                    value={form.body}
                    onChange={setBody}
                    placeholder={'{\n  "event": "ping"\n}'}
                    minHeight="180px"
                    aria-label="Request body"
                  />
                  {showBodyNote && (
                    <p className="text-muted-foreground text-[0.625rem]">
                      {form.method} requests usually have no body — it will
                      still be sent.
                    </p>
                  )}
                </div>

                <Field label="Timeout" htmlFor="timeoutSeconds">
                  <select
                    id="timeoutSeconds"
                    value={form.timeoutSeconds}
                    onChange={(e) => update('timeoutSeconds', e.target.value)}
                    className={selectClass}
                  >
                    {[5, 10, 15, 30, 60, 120, 300].map((s) => (
                      <option key={s} value={String(s)}>
                        {s} seconds
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            ) : (
              <>
                <Field label="To" htmlFor="emailTo">
                  <Input
                    id="emailTo"
                    value={form.emailTo}
                    onChange={(e) => update('emailTo', e.target.value)}
                    placeholder="recipient@example.com (comma-separated for many)"
                    required
                    autoFocus
                  />
                </Field>
                <Row>
                  <Field label="From" htmlFor="emailFrom">
                    <Input
                      id="emailFrom"
                      value={form.emailFrom}
                      onChange={(e) => update('emailFrom', e.target.value)}
                      placeholder="Optional — worker VEYRA_SMTP_FROM"
                    />
                  </Field>
                  <Field label="Reply-To" htmlFor="emailReplyTo">
                    <Input
                      id="emailReplyTo"
                      value={form.emailReplyTo}
                      onChange={(e) => update('emailReplyTo', e.target.value)}
                      placeholder="Optional"
                    />
                  </Field>
                </Row>
                <Field label="Subject" htmlFor="emailSubject">
                  <Input
                    id="emailSubject"
                    value={form.emailSubject}
                    onChange={(e) => update('emailSubject', e.target.value)}
                    placeholder="Subject"
                    required
                  />
                </Field>
                <Field label="Text body" htmlFor="emailText">
                  <Textarea
                    id="emailText"
                    value={form.emailText}
                    onChange={(e) => update('emailText', e.target.value)}
                    rows={5}
                    placeholder="Plain-text body"
                  />
                </Field>
                <Field label="HTML body" htmlFor="emailHtml">
                  <Textarea
                    id="emailHtml"
                    value={form.emailHtml}
                    onChange={(e) => update('emailHtml', e.target.value)}
                    rows={5}
                    placeholder="Optional HTML — provide text and/or HTML"
                    className="font-mono text-xs"
                  />
                </Field>
              </>
            )}

            <Field label="Retry attempts" htmlFor="maxAttempts">
              <select
                id="maxAttempts"
                value={form.maxAttempts}
                onChange={(e) => update('maxAttempts', e.target.value)}
                className={selectClass}
              >
                {[1, 2, 3, 5, 10].map((n) => (
                  <option key={n} value={String(n)}>
                    {n} {n === 1 ? 'attempt' : 'attempts'}
                  </option>
                ))}
              </select>
            </Field>

            <div className="border-border border-t pt-2">
              <button
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
                aria-expanded={advancedOpen}
              >
                <span>{advancedOpen ? '▾' : '▸'}</span> Advanced options
              </button>

              {advancedOpen && (
                <div className="mt-3 space-y-3">
                  <Row>
                    <Field label="Queue" htmlFor="queue">
                      <select
                        id="queue"
                        value={form.queue}
                        onChange={(e) => update('queue', e.target.value)}
                        className={selectClass}
                      >
                        <option value="default">default</option>
                      </select>
                    </Field>
                    <Field label="Priority" htmlFor="priority">
                      <select
                        id="priority"
                        value={form.priority}
                        onChange={(e) => update('priority', e.target.value)}
                        className={selectClass}
                      >
                        {[9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((p) => (
                          <option key={p} value={String(p)}>
                            {p}
                            {p === 5
                              ? ' (default)'
                              : p === 9
                                ? ' (highest)'
                                : p === 0
                                  ? ' (lowest)'
                                  : ''}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </Row>

                  <Row>
                    <Field label="Schedule" htmlFor="scheduledFor">
                      <Input
                        id="scheduledFor"
                        type="datetime-local"
                        value={form.scheduledFor}
                        onChange={(e) => update('scheduledFor', e.target.value)}
                      />
                    </Field>
                    <Field label="Idempotency key" htmlFor="idempotencyKey">
                      <Input
                        id="idempotencyKey"
                        value={form.idempotencyKey}
                        onChange={(e) =>
                          update('idempotencyKey', e.target.value)
                        }
                        placeholder="Optional"
                      />
                    </Field>
                  </Row>

                  <div className="space-y-2">
                    <label className="border-border hover:bg-muted/40 flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 text-xs">
                      <input
                        type="checkbox"
                        checked={form.rawMode}
                        onChange={toggleRawMode}
                        className="border-border text-foreground accent-foreground mt-0.5 size-3.5 shrink-0 rounded-sm border"
                      />
                      <span className="min-w-0">
                        <span className="text-foreground block font-medium">
                          Edit raw job payload
                        </span>
                        <span className="text-muted-foreground text-[0.625rem] leading-snug">
                          Overrides the fields above with a full JSON object.
                        </span>
                      </span>
                    </label>
                    {form.rawMode ? (
                      <JsonEditor
                        value={form.rawPayload}
                        onChange={(v) => update('rawPayload', v)}
                        minHeight="220px"
                        aria-label="Raw job payload"
                        placeholder={
                          form.jobKind === 'email'
                            ? '{\n  "to": "you@example.com",\n  "subject": "Hi",\n  "text": "…"\n}'
                            : '{\n  "url": "https://…",\n  "method": "POST"\n}'
                        }
                      />
                    ) : (
                      <div className="space-y-1">
                        <span className="text-muted-foreground text-[0.625rem]">
                          Payload preview
                        </span>
                        <CodeBlock language="json">
                          {generatedPayload}
                        </CodeBlock>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {(validationError ?? serverError) && (
              <div
                role="alert"
                className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs"
              >
                {validationError ?? serverError}
              </div>
            )}
          </CardContent>

          <div className="border-border flex items-center justify-end gap-2 border-t px-3 py-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setForm(INITIAL_FORM);
                setValidationError(null);
                mutation.reset();
              }}
              disabled={mutation.isPending}
            >
              Reset
            </Button>
            <Button type="submit" size="sm" disabled={mutation.isPending}>
              {mutation.isPending ? 'Creating…' : 'Create & run'}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2">{children}</div>;
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

function hasContentType(rows: HeaderRow[]): boolean {
  return rows.some((h) => h.key.trim().toLowerCase() === 'content-type');
}

function ensureContentType(rows: HeaderRow[], value: string): HeaderRow[] {
  const empty = rows.findIndex(
    (h) => h.key.trim() === '' && h.value.trim() === '',
  );
  if (empty >= 0) {
    return rows.map((h, i) =>
      i === empty ? { key: 'Content-Type', value } : h,
    );
  }
  return [...rows, { key: 'Content-Type', value }];
}

function headersToObject(rows: HeaderRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of rows) {
    const k = key.trim();
    if (k === '') continue;
    out[k] = value;
  }
  return out;
}

function buildHttpPayload(form: FormState): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    url: form.url.trim(),
    method: form.method,
  };
  const headers = headersToObject(form.headers);
  if (Object.keys(headers).length > 0) payload.headers = headers;
  if (form.body !== '') payload.body = form.body;
  if (form.timeoutSeconds.trim() !== '') {
    const t = Number(form.timeoutSeconds);
    if (Number.isFinite(t)) payload.timeoutSeconds = t;
  }
  return payload;
}

function splitAddresses(raw: string): string[] {
  return raw
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildEmailPayload(form: FormState): Record<string, unknown> {
  const to = splitAddresses(form.emailTo);
  const payload: Record<string, unknown> = {
    to: to.length <= 1 ? (to[0] ?? '') : to,
    subject: form.emailSubject.trim(),
  };
  const from = form.emailFrom.trim();
  if (from) payload.from = from;
  const replyTo = form.emailReplyTo.trim();
  if (replyTo) payload.replyTo = replyTo;
  if (form.emailText !== '') payload.text = form.emailText;
  if (form.emailHtml !== '') payload.html = form.emailHtml;
  return payload;
}

function isValidHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

type ParseResult =
  | { value: EnqueueJobInput }
  | { error: string; advanced?: boolean };

function parseForm(form: FormState): ParseResult {
  const handler = form.jobKind === 'email' ? 'send_email' : 'http_request';
  let payload: unknown;

  if (form.rawMode) {
    try {
      payload = JSON.parse(form.rawPayload);
    } catch (e) {
      return {
        error: `Payload must be valid JSON: ${(e as Error).message}`,
        advanced: true,
      };
    }
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload)
    ) {
      return { error: 'Payload must be a JSON object.', advanced: true };
    }
    const rec = payload as Record<string, unknown>;
    if (handler === 'http_request') {
      if (typeof rec.url !== 'string' || rec.url.trim() === '') {
        return { error: 'Payload is missing a "url" string.', advanced: true };
      }
    } else if (rec.to === undefined || rec.to === null || rec.to === '') {
      return { error: 'Payload is missing "to".', advanced: true };
    }
  } else if (form.jobKind === 'email') {
    const to = splitAddresses(form.emailTo);
    if (to.length === 0) return { error: 'To is required.' };
    if (form.emailSubject.trim() === '')
      return { error: 'Subject is required.' };
    if (form.emailText.trim() === '' && form.emailHtml.trim() === '') {
      return { error: 'Provide a text and/or HTML body.' };
    }
    payload = buildEmailPayload(form);
  } else {
    const url = form.url.trim();
    if (url === '') return { error: 'URL is required.' };
    if (!isValidHttpUrl(url)) {
      return {
        error: 'URL must be a valid http(s) URL (e.g. https://example.com).',
      };
    }
    if (form.body.trim() !== '') {
      try {
        JSON.parse(form.body);
      } catch (e) {
        return {
          error: `Body is not valid JSON: ${(e as Error).message}`,
        };
      }
    }
    if (form.timeoutSeconds.trim() !== '') {
      const t = Number(form.timeoutSeconds);
      if (!Number.isInteger(t) || t < 1 || t > 300) {
        return {
          error: 'Timeout must be an integer between 1 and 300 seconds.',
        };
      }
    }
    payload = buildHttpPayload(form);
  }

  const queue = form.queue.trim();
  if (queue === '') return { error: 'Queue is required.', advanced: true };

  const input: EnqueueJobInput = { handler, queue, payload };

  const m = Number(form.maxAttempts);
  if (!Number.isInteger(m) || m < 1) {
    return { error: 'Retry attempts must be an integer ≥ 1.' };
  }
  input.maxAttempts = m;

  if (form.priority.trim() !== '') {
    const p = Number(form.priority);
    if (!Number.isInteger(p) || p < 0 || p > 9) {
      return {
        error: 'Priority must be an integer between 0 and 9.',
        advanced: true,
      };
    }
    input.priority = p;
  }

  if (form.scheduledFor.trim() !== '') {
    const d = new Date(form.scheduledFor);
    if (Number.isNaN(d.getTime())) {
      return {
        error: 'Schedule time must be a valid date/time.',
        advanced: true,
      };
    }
    input.scheduledFor = d.toISOString();
  }

  const key = form.idempotencyKey.trim();
  if (key) input.idempotencyKey = key;

  return { value: input };
}
