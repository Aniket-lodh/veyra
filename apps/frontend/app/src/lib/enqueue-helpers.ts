import type { EnqueueJobInput } from '@/lib/api/jobs';
import type { QueueStatsResponse } from '@/lib/api/stats';
import type { BackoffStrategy, Worker } from '@/lib/types';

export type HandlerType = 'http_request' | 'send_email' | 'noop' | 'custom';

export const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const BODYLESS_METHODS = new Set<HttpMethod>(['GET', 'HEAD']);

export interface HeaderRow {
  key: string;
  value: string;
}

export type BackoffKind = 'exponential' | 'fixed';

export type BackoffPresetId =
  | 'default'
  | 'fast'
  | 'gentle'
  | 'fixed-15'
  | 'fixed-60'
  | 'custom';

export interface BackoffPreset {
  id: BackoffPresetId;
  label: string;
  description: string;
  strategy: BackoffStrategy;
}

export const BACKOFF_PRESETS: BackoffPreset[] = [
  {
    id: 'default',
    label: 'Standard (30s → 1h)',
    description: 'Exponential backoff starting at 30s up to 1 hour',
    strategy: { kind: 'exponential', baseSeconds: 30, capSeconds: 3600 },
  },
  {
    id: 'fast',
    label: 'Fast (5s → 60s)',
    description: 'Quick retry for transient network hiccups',
    strategy: { kind: 'exponential', baseSeconds: 5, capSeconds: 60 },
  },
  {
    id: 'gentle',
    label: 'Gentle (60s → 2h)',
    description: 'Polite backoff for external rate-limited APIs',
    strategy: { kind: 'exponential', baseSeconds: 60, capSeconds: 7200 },
  },
  {
    id: 'fixed-15',
    label: 'Fixed 15s',
    description: 'Constant 15 second delay between retries',
    strategy: { kind: 'fixed', seconds: 15 },
  },
  {
    id: 'fixed-60',
    label: 'Fixed 60s',
    description: 'Constant 1 minute delay between retries',
    strategy: { kind: 'fixed', seconds: 60 },
  },
];

export interface EnqueueFormState {
  handlerType: HandlerType;
  customHandler: string;
  queue: string;
  priority: number;
  maxAttempts: number;

  // Backoff
  backoffKind: BackoffKind;
  backoffBaseSeconds: number;
  backoffCapSeconds: number;
  backoffFixedSeconds: number;
  backoffPreset: BackoffPresetId;

  // Scheduling
  scheduledFor: string; // ISO string or datetime-local string

  // Idempotency
  idempotencyKey: string;

  // http_request fields
  httpUrl: string;
  httpMethod: HttpMethod;
  httpHeaders: HeaderRow[];
  httpBody: string;
  httpTimeoutSeconds: number;

  // send_email fields
  emailTo: string;
  emailFrom: string;
  emailReplyTo: string;
  emailSubject: string;
  emailText: string;
  emailHtml: string;

  // noop fields
  noopMessage: string;
  noopSimulatedDelayMs: number;

  // Raw JSON mode
  rawMode: boolean;
  rawPayload: string;
}

export const INITIAL_ENQUEUE_FORM: EnqueueFormState = {
  handlerType: 'http_request',
  customHandler: '',
  queue: 'default',
  priority: 5,
  maxAttempts: 3,

  backoffKind: 'exponential',
  backoffBaseSeconds: 30,
  backoffCapSeconds: 3600,
  backoffFixedSeconds: 30,
  backoffPreset: 'default',

  scheduledFor: '',
  idempotencyKey: '',

  httpUrl: '',
  httpMethod: 'POST',
  httpHeaders: [{ key: 'Content-Type', value: 'application/json' }],
  httpBody: '{\n  "event": "user.signup",\n  "userId": "usr_98124"\n}',
  httpTimeoutSeconds: 30,

  emailTo: '',
  emailFrom: '',
  emailReplyTo: '',
  emailSubject: '',
  emailText: '',
  emailHtml: '',

  noopMessage: 'Operational queue health check ping',
  noopSimulatedDelayMs: 0,

  rawMode: false,
  rawPayload: '',
};

export interface HandlerStarterPreset {
  label: string;
  description: string;
  handlerType: HandlerType;
  patch: Partial<EnqueueFormState>;
}

export const STARTER_PRESETS: HandlerStarterPreset[] = [
  {
    label: 'POST Webhook',
    description: 'Standard JSON POST request with retry backoff',
    handlerType: 'http_request',
    patch: {
      httpMethod: 'POST',
      httpUrl: 'https://httpbin.org/post',
      httpHeaders: [{ key: 'Content-Type', value: 'application/json' }],
      httpBody: '{\n  "event": "order.completed",\n  "orderId": "ord_5521"\n}',
      httpTimeoutSeconds: 30,
    },
  },
  {
    label: 'GET Health Ping',
    description: 'Zero-body HTTP GET probe with short timeout',
    handlerType: 'http_request',
    patch: {
      httpMethod: 'GET',
      httpUrl: 'https://httpbin.org/get',
      httpHeaders: [{ key: 'Accept', value: 'application/json' }],
      httpBody: '',
      httpTimeoutSeconds: 10,
    },
  },
  {
    label: 'Operator Alert Email',
    description: 'Critical notification sent to operators via SMTP',
    handlerType: 'send_email',
    patch: {
      emailTo: 'ops@example.com',
      emailFrom: 'alerts@veyra.internal',
      emailSubject: '[ALERT] Elevated Queue Latency in default queue',
      emailText:
        'Queue depth has exceeded threshold. Automated diagnostic dispatch.',
      emailHtml: '',
      priority: 8,
    },
  },
  {
    label: 'No-op Health Check',
    description: 'Instant zero-dependency task to verify worker execution',
    handlerType: 'noop',
    patch: {
      noopMessage: 'Veyra queue health check',
      noopSimulatedDelayMs: 0,
      priority: 5,
    },
  },
  {
    label: 'Custom Worker SDK',
    description:
      'Custom handler dispatched to an external Node/TypeScript worker',
    handlerType: 'custom',
    patch: {
      customHandler: 'process_event',
      queue: 'default',
      rawMode: true,
      rawPayload: JSON.stringify(
        {
          action: 'process_event',
          entityId: 'ent_98124',
          attributes: {
            priority: 'high',
            source: 'external_system',
          },
        },
        null,
        2,
      ),
    },
  },
];

export function hasContentType(rows: HeaderRow[]): boolean {
  return rows.some((h) => h.key.trim().toLowerCase() === 'content-type');
}

export function ensureContentType(
  rows: HeaderRow[],
  value = 'application/json',
): HeaderRow[] {
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

export function headersToObject(rows: HeaderRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of rows) {
    const k = key.trim();
    if (k === '') continue;
    out[k] = value;
  }
  return out;
}

export function splitEmailAddresses(raw: string): string[] {
  return raw
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function buildHttpPayload(
  form: Pick<
    EnqueueFormState,
    'httpUrl' | 'httpMethod' | 'httpHeaders' | 'httpBody' | 'httpTimeoutSeconds'
  >,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    url: form.httpUrl.trim(),
    method: form.httpMethod,
  };
  const headers = headersToObject(form.httpHeaders);
  if (Object.keys(headers).length > 0) {
    payload.headers = headers;
  }
  if (form.httpBody.trim() !== '') {
    try {
      payload.body = JSON.parse(form.httpBody);
    } catch {
      payload.body = form.httpBody;
    }
  }
  if (form.httpTimeoutSeconds > 0) {
    payload.timeoutSeconds = form.httpTimeoutSeconds;
  }
  return payload;
}

export function buildEmailPayload(
  form: Pick<
    EnqueueFormState,
    | 'emailTo'
    | 'emailFrom'
    | 'emailReplyTo'
    | 'emailSubject'
    | 'emailText'
    | 'emailHtml'
  >,
): Record<string, unknown> {
  const to = splitEmailAddresses(form.emailTo);
  const payload: Record<string, unknown> = {
    to: to.length <= 1 ? (to[0] ?? '') : to,
    subject: form.emailSubject.trim(),
  };
  if (form.emailFrom.trim()) payload.from = form.emailFrom.trim();
  if (form.emailReplyTo.trim()) payload.replyTo = form.emailReplyTo.trim();
  if (form.emailText.trim() !== '') payload.text = form.emailText;
  if (form.emailHtml.trim() !== '') payload.html = form.emailHtml;
  return payload;
}

export function buildNoopPayload(
  form: Pick<EnqueueFormState, 'noopMessage' | 'noopSimulatedDelayMs'>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    message: form.noopMessage.trim() || 'noop',
  };
  if (form.noopSimulatedDelayMs > 0) {
    payload.delayMs = form.noopSimulatedDelayMs;
  }
  return payload;
}

export function resolveEffectiveHandlerName(form: EnqueueFormState): string {
  if (form.handlerType === 'custom') {
    return form.customHandler.trim();
  }
  return form.handlerType;
}

export function buildEffectivePayload(form: EnqueueFormState): {
  payload: unknown;
  error?: string;
} {
  if (form.rawMode) {
    const trimmed = form.rawPayload.trim();
    if (trimmed === '') {
      return { payload: {}, error: 'Raw payload cannot be empty' };
    }
    try {
      const parsed = JSON.parse(trimmed);
      return { payload: parsed };
    } catch (e) {
      return {
        payload: null,
        error: `Invalid JSON payload: ${(e as Error).message}`,
      };
    }
  }

  switch (form.handlerType) {
    case 'http_request':
      return { payload: buildHttpPayload(form) };
    case 'send_email':
      return { payload: buildEmailPayload(form) };
    case 'noop':
      return { payload: buildNoopPayload(form) };
    case 'custom': {
      const trimmed = form.rawPayload.trim();
      if (trimmed === '') {
        return { payload: {} };
      }
      try {
        return { payload: JSON.parse(trimmed) };
      } catch (e) {
        return {
          payload: null,
          error: `Invalid custom JSON payload: ${(e as Error).message}`,
        };
      }
    }
  }
}

export function isValidHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export type ParseEnqueueFormResult =
  | { ok: true; value: EnqueueJobInput }
  | { ok: false; error: string; field?: string };

export function validateAndParseEnqueueForm(
  form: EnqueueFormState,
): ParseEnqueueFormResult {
  const handler = resolveEffectiveHandlerName(form);
  if (!handler) {
    return {
      ok: false,
      error: 'Handler name is required.',
      field: form.handlerType === 'custom' ? 'customHandler' : 'handlerType',
    };
  }

  const queue = form.queue.trim();
  if (!queue) {
    return { ok: false, error: 'Queue name is required.', field: 'queue' };
  }

  // Priority validation (0-9)
  const priority = Number(form.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > 9) {
    return {
      ok: false,
      error: 'Priority must be an integer between 0 (lowest) and 9 (highest).',
      field: 'priority',
    };
  }

  // Max attempts validation (>= 1)
  const maxAttempts = Number(form.maxAttempts);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    return {
      ok: false,
      error: 'Retry attempts must be an integer ≥ 1.',
      field: 'maxAttempts',
    };
  }

  // Backoff validation
  let backoff: BackoffStrategy;
  if (form.backoffKind === 'exponential') {
    const base = Number(form.backoffBaseSeconds);
    const cap = Number(form.backoffCapSeconds);
    if (!Number.isInteger(base) || base <= 0) {
      return {
        ok: false,
        error: 'Backoff base seconds must be a positive integer.',
        field: 'backoffBaseSeconds',
      };
    }
    if (!Number.isInteger(cap) || cap <= 0) {
      return {
        ok: false,
        error: 'Backoff cap seconds must be a positive integer.',
        field: 'backoffCapSeconds',
      };
    }
    if (cap < base) {
      return {
        ok: false,
        error:
          'Backoff cap seconds must be greater than or equal to base seconds.',
        field: 'backoffCapSeconds',
      };
    }
    backoff = { kind: 'exponential', baseSeconds: base, capSeconds: cap };
  } else {
    const secs = Number(form.backoffFixedSeconds);
    if (!Number.isInteger(secs) || secs <= 0) {
      return {
        ok: false,
        error: 'Fixed backoff delay must be a positive integer in seconds.',
        field: 'backoffFixedSeconds',
      };
    }
    backoff = { kind: 'fixed', seconds: secs };
  }

  // Payload extraction & verification
  const payloadRes = buildEffectivePayload(form);
  if (payloadRes.error || payloadRes.payload === null) {
    return {
      ok: false,
      error: payloadRes.error ?? 'Invalid payload format.',
      field: form.rawMode ? 'rawPayload' : undefined,
    };
  }

  // Form-mode specific checks
  if (!form.rawMode) {
    if (form.handlerType === 'http_request') {
      const url = form.httpUrl.trim();
      if (!url) {
        return {
          ok: false,
          error: 'URL is required for HTTP request.',
          field: 'httpUrl',
        };
      }
      if (!isValidHttpUrl(url)) {
        return {
          ok: false,
          error: 'URL must start with http:// or https://.',
          field: 'httpUrl',
        };
      }
      if (form.httpBody.trim() !== '') {
        try {
          JSON.parse(form.httpBody);
        } catch (e) {
          return {
            ok: false,
            error: `Request body is not valid JSON: ${(e as Error).message}`,
            field: 'httpBody',
          };
        }
      }
      if (
        !Number.isInteger(form.httpTimeoutSeconds) ||
        form.httpTimeoutSeconds < 1 ||
        form.httpTimeoutSeconds > 300
      ) {
        return {
          ok: false,
          error: 'HTTP timeout must be an integer between 1 and 300 seconds.',
          field: 'httpTimeoutSeconds',
        };
      }
    } else if (form.handlerType === 'send_email') {
      const recipients = splitEmailAddresses(form.emailTo);
      if (recipients.length === 0) {
        return {
          ok: false,
          error: 'At least one recipient email address is required in "To".',
          field: 'emailTo',
        };
      }
      if (!form.emailSubject.trim()) {
        return {
          ok: false,
          error: 'Email subject is required.',
          field: 'emailSubject',
        };
      }
      if (!form.emailText.trim() && !form.emailHtml.trim()) {
        return {
          ok: false,
          error: 'Provide a text and/or HTML body for the email.',
          field: 'emailText',
        };
      }
    }
  }

  const input: EnqueueJobInput = {
    handler,
    queue,
    priority,
    maxAttempts,
    backoff,
    payload: payloadRes.payload,
  };

  // Schedule timestamp
  if (form.scheduledFor.trim()) {
    const d = new Date(form.scheduledFor);
    if (Number.isNaN(d.getTime())) {
      return {
        ok: false,
        error: 'Scheduled time must be a valid ISO date/time.',
        field: 'scheduledFor',
      };
    }
    input.scheduledFor = d.toISOString();
  }

  // Idempotency Key
  const key = form.idempotencyKey.trim();
  if (key) {
    input.idempotencyKey = key;
  }

  return { ok: true, value: input };
}

// ULID Crockford Base32 alphabet
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateULID(now = Date.now()): string {
  let timeStr = '';
  let time = now;
  for (let i = 9; i >= 0; i--) {
    const mod = time % 32;
    timeStr = ENCODING[mod] + timeStr;
    time = Math.floor(time / 32);
  }

  let randStr = '';
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buffer = new Uint8Array(16);
    crypto.getRandomValues(buffer);
    for (let i = 0; i < 16; i++) {
      randStr += ENCODING[buffer[i] % 32];
    }
  } else {
    for (let i = 0; i < 16; i++) {
      randStr += ENCODING[Math.floor(Math.random() * 32)];
    }
  }

  return timeStr + randStr;
}

export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function generateIdempotencyKey(
  type: 'uuid' | 'ulid' | 'timestamp',
  prefix = '',
): string {
  let core = '';
  switch (type) {
    case 'uuid':
      core = generateUUID();
      break;
    case 'ulid':
      core = generateULID();
      break;
    case 'timestamp':
      core = `disp-${Date.now()}`;
      break;
  }
  return prefix ? `${prefix}-${core}` : core;
}

export function computeScheduledTime(
  offsetMinutes: number,
  baseDate = new Date(),
): string {
  if (offsetMinutes <= 0) return '';
  const target = new Date(baseDate.getTime() + offsetMinutes * 60 * 1000);
  // Format for input[type="datetime-local"] in local time
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = target.getFullYear();
  const month = pad(target.getMonth() + 1);
  const day = pad(target.getDate());
  const hours = pad(target.getHours());
  const mins = pad(target.getMinutes());
  return `${year}-${month}-${day}T${hours}:${mins}`;
}

export interface QueueReadinessResult {
  totalFleetWorkers: number;
  queueWorkers: number;
  handlerWorkers: number;
  queueDepth: number;
  status: 'healthy' | 'unserviced' | 'no-workers' | 'loading';
  warning?: string;
}

export function computeQueueReadiness(
  queue: string,
  handler: string,
  stats?: QueueStatsResponse,
  workers?: Worker[],
  isLoading = false,
): QueueReadinessResult {
  if (isLoading || (stats === undefined && workers === undefined)) {
    return {
      totalFleetWorkers: 0,
      queueWorkers: 0,
      handlerWorkers: 0,
      queueDepth: 0,
      status: 'loading',
    };
  }

  const activeFleet = (workers ?? []).filter((w) => w.state !== 'disconnected');
  const totalFleetWorkers = activeFleet.length;

  const targetQueue = queue.trim() || 'default';
  const targetHandler = handler.trim();

  // Workers that list this queue in their subscriptions
  const queueWorkers = activeFleet.filter(
    (w) => w.queues.length === 0 || w.queues.includes(targetQueue),
  ).length;

  // Workers that also list this handler
  const handlerWorkers = activeFleet.filter((w) => {
    const hasQueue = w.queues.length === 0 || w.queues.includes(targetQueue);
    const hasHandler =
      w.handlers.length === 0 ||
      (targetHandler ? w.handlers.includes(targetHandler) : true);
    return hasQueue && hasHandler;
  }).length;

  const queueStat = (stats?.queues ?? []).find((q) => q.name === targetQueue);
  const queueDepth = queueStat?.depth ?? 0;

  if (totalFleetWorkers === 0) {
    return {
      totalFleetWorkers: 0,
      queueWorkers: 0,
      handlerWorkers: 0,
      queueDepth,
      status: 'no-workers',
      warning:
        'Zero active workers in the entire fleet. Jobs dispatched now will remain queued until workers start.',
    };
  }

  if (handlerWorkers === 0) {
    return {
      totalFleetWorkers,
      queueWorkers,
      handlerWorkers: 0,
      queueDepth,
      status: 'unserviced',
      warning: `No active workers are subscribed to queue "${targetQueue}" with handler "${targetHandler}". Jobs will wait unserviced.`,
    };
  }

  return {
    totalFleetWorkers,
    queueWorkers,
    handlerWorkers,
    queueDepth,
    status: 'healthy',
  };
}

export function generateCurlSnippet(
  input: EnqueueJobInput,
  apiOrigin = window.location.origin,
): string {
  const url = `${apiOrigin}/jobs`;
  const body = JSON.stringify(input, null, 2);

  const lines = [
    `curl -X POST "${url}" \\`,
    `  -H "Content-Type: application/json" \\`,
  ];

  if (input.idempotencyKey) {
    lines.push(`  -H "Idempotency-Key: ${input.idempotencyKey}" \\`);
  }

  lines.push(`  -d '${body.replace(/'/g, "'\\''")}'`);

  return lines.join('\n');
}

export const DEFAULT_CUSTOM_PAYLOAD_EXAMPLE = JSON.stringify(
  {
    action: 'process_event',
    entityId: 'ent_98124',
    attributes: {
      priority: 'high',
      source: 'external_system',
    },
  },
  null,
  2,
);

export function generateWorkerSnippet(
  handlerName = 'my_custom_task',
  queueName = 'default',
  apiOrigin = typeof window !== 'undefined' && window?.location?.origin
    ? window.location.origin
    : 'http://localhost:8080',
): string {
  const handler = handlerName.trim() || 'my_custom_task';
  const queue = queueName.trim() || 'default';

  return `import { VeyraClient, NonRetryableError } from '@veyra/sdk';

const client = new VeyraClient({
  baseUrl: process.env.VEYRA_API_URL || '${apiOrigin}',
  apiKey: process.env.VEYRA_API_KEY || 'veyra_...',
});

const worker = client.createWorker({
  queues: ['${queue}'],
  concurrency: 5,
});

worker.registerHandler('${handler}', async (job, ctx) => {
  console.log(\`[Worker] Processing job \${job.id} (attempt \${ctx.attempt})\`);

  if (ctx.signal.aborted) {
    throw new Error('Execution aborted: job lease was lost');
  }

  const payload = job.payload as Record<string, unknown>;
  console.log('Received payload:', payload);

  // Business logic execution:
  // Throw NonRetryableError to immediately dead-letter invalid payloads without retries:
  // if (!payload.entityId) throw new NonRetryableError('entityId is required');

  return { success: true, processedAt: new Date().toISOString() };
});

await worker.start();
console.log('Worker active and polling for jobs...');
`;
}
