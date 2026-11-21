/**
 * Type-level tests. Compiled with `tsc -p tsconfig.test.json`; never executed.
 */

import {
  defineHandler,
  parseWebhook,
  staticSchema,
  verifyWebhookSignature,
  VeyraClient,
  VeyraWorker,
  type StandardSchemaV1,
} from '../src/index.js';

interface MyHandlers {
  send_email: {
    payload: { to: string; subject: string };
    result: { messageId: string };
  };
}

const client = new VeyraClient({ baseUrl: 'http://localhost', apiKey: 'key' });
const typedClient = new VeyraClient<MyHandlers>({
  baseUrl: 'http://localhost',
  apiKey: 'key',
});
const worker = new VeyraWorker(client, { queues: ['default'] });
const typedWorker = new VeyraWorker(typedClient, { queues: ['default'] });

// --- Built-in handlers -------------------------------------------------------

const httpJob = await client.enqueue({
  handler: 'http_request',
  payload: { url: 'https://example.com', method: 'GET' },
});
const statusCode: number = httpJob.result!.statusCode;
const responseExcerpt: string = httpJob.result!.responseExcerpt;
void statusCode;
void responseExcerpt;

// @ts-expect-error `url` is required
client.enqueue({ handler: 'http_request', payload: { method: 'GET' } });
// @ts-expect-error `url` must be a string
client.enqueue({ handler: 'http_request', payload: { url: 42 } });
// @ts-expect-error unknown fields are rejected
client.enqueue({ handler: 'http_request', payload: { url: 'x', nope: true } });

// --- Typed registry ----------------------------------------------------------

const emailJob = await typedClient.enqueue({
  handler: 'send_email',
  payload: { to: 'a@b.c', subject: 'Hello' },
});
const messageId: string = emailJob.result!.messageId;
void messageId;

// @ts-expect-error payload must match the registry
typedClient.enqueue({ handler: 'send_email', payload: { to: 1, subject: 'Hi' } });
// Built-ins remain available after merging.
typedClient.enqueue({ handler: 'http_request', payload: { url: 'https://example.com' } });

// Arbitrary string handlers fall back to inferred payloads.
const dynamicName: string = 'anything';
const customJob = await client.enqueue({
  handler: dynamicName,
  payload: { anything: 1 },
});
const anything: number = customJob.payload.anything;
void anything;

// --- defineHandler -----------------------------------------------------------

const sendEmail = defineHandler<{ to: string }, { messageId: string }>({
  name: 'send_email',
});

const definitionJob = await client.enqueue(sendEmail, { to: 'a@b.c' });
const definitionMessageId: string = definitionJob.result!.messageId;
void definitionMessageId;

// Object form with HandlerDefinition
const definitionObjJob = await client.enqueue({
  handler: sendEmail,
  payload: { to: 'a@b.c' },
});
const defObjMessageId: string = definitionObjJob.result!.messageId;
void defObjMessageId;

// @ts-expect-error payload must match the definition in object form
client.enqueue({ handler: sendEmail, payload: { to: 1 } });

// @ts-expect-error payload must match the definition
client.enqueue(sendEmail, { to: 1 });

const staticDefinition = defineHandler({
  name: 'static_handler',
  payload: staticSchema<{ id: string }>(),
  result: staticSchema<{ ok: boolean }>(),
});
const staticJob = await client.enqueue(staticDefinition, { id: '1' });
const staticOk: boolean = staticJob.result!.ok;
void staticOk;
// @ts-expect-error payload must match the static schema
client.enqueue(staticDefinition, { id: 1 });

declare const runtimePayload: StandardSchemaV1<
  { to: string },
  { to: string }
>;
declare const runtimeResult: StandardSchemaV1<
  { messageId: string },
  { messageId: string }
>;
const inferredDefinition = defineHandler({
  name: 'inferred',
  payload: runtimePayload,
  result: runtimeResult,
});
const inferredJob = await client.enqueue(inferredDefinition, { to: 'a@b.c' });
const inferredId: string = inferredJob.result!.messageId;
void inferredId;

// --- Worker registration -----------------------------------------------------

worker.register(sendEmail, async (job) => {
  const to: string = job.payload.to;
  return { messageId: to };
});

// @ts-expect-error result must match the definition
worker.register(sendEmail, async () => {
  return { messageId: 1 };
});

worker.register(sendEmail, async (job) => {
  // @ts-expect-error payload is typed in the callback
  const wrong: number = job.payload.to;
  return { messageId: wrong.toString() };
});

worker.register('http_request', async (job) => {
  const url: string = job.payload.url;
  void url;
  return {
    statusCode: 200,
    durationMs: 5,
    contentType: 'text/plain',
    responseExcerpt: 'ok',
  };
});

// @ts-expect-error result must match the built-in http_request result
worker.register('http_request', async () => {
  return { statusCode: '200' };
});

typedWorker.register('send_email', async (job) => {
  const to: string = job.payload.to;
  return { messageId: to };
});

// --- Retrieval ---------------------------------------------------------------

const fetched = await client.getJob('job_1', sendEmail);
const fetchedMessageId: string = fetched.result!.messageId;
void fetchedMessageId;

const fetchedHttp = await client.getJob('job_1', 'http_request');
const fetchedHttpCode: number = fetchedHttp.result!.statusCode;
const fetchedHttpExcerpt: string = fetchedHttp.result!.responseExcerpt;
void fetchedHttpCode;
void fetchedHttpExcerpt;

const resultOnly = await client.getJob<{ ok: boolean }>('job_1');
const resultOnlyOk: boolean = resultOnly.result!.ok;
void resultOnlyOk;

const legacyJob = await client.getJob<{ q: string }, { r: number }>('job_1');
const legacyPayload: string = legacyJob.payload.q;
const legacyResult: number = legacyJob.result!.r;
void legacyPayload;
void legacyResult;

// --- Webhooks ----------------------------------------------------------------

const plainEvent = await parseWebhook<{ ok: boolean }>('{}');
const plainOk: boolean = plainEvent.result!.ok;
void plainOk;

const typedEvent = await parseWebhook('{}', sendEmail);
const typedEventId: string = typedEvent.result!.messageId;
void typedEventId;

const signatureValid: boolean = await verifyWebhookSignature(
  '{}',
  'sha256=00',
  'secret'
);
void signatureValid;

// --- Backwards compatibility -------------------------------------------------

client.enqueue({
  handler: 'legacy_handler',
  queue: 'default',
  payload: { legacy: true },
  priority: 7,
  maxAttempts: 5,
});

worker.registerHandler('legacy_handler', async (job) => {
  const legacy = job.payload as { legacy: boolean };
  return { done: legacy.legacy };
});

export {};
