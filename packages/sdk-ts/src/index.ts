/**
 * @aniket-lodh/veyra-sdk - Lightweight, zero-dependency TypeScript & Node.js SDK
 * for the Veyra Distributed Execution Platform.
 */

// Public Classes
export { VeyraClient } from './client.js';
export { VeyraWorker } from './worker.js';

// Handler Definitions & Schema Helpers
export { defineHandler, isHandlerDefinition } from './handlers.js';
export { staticSchema } from './standard-schema.js';

// Webhook Helpers
export { parseWebhook, verifyWebhookSignature } from './webhook.js';

// Error Classes & Helpers
export {
  VeyraError,
  VeyraValidationError,
  VeyraApiError,
  VeyraAuthError,
  VeyraNotFoundError,
  VeyraConflictError,
  LeaseLostError,
  VeyraRateLimitError,
  VeyraTimeoutError,
  VeyraNetworkError,
  VeyraWebhookError,
  NonRetryableError,
  isNonRetryable,
} from './errors.js';

// Types
export type {
  VeyraClientConfig,
  VeyraWorkerOptions,
  VeyraLogger,
  EnqueueOptions,
  EnqueueJobInput,
  DefinitionEnqueueInput,
  TypedEnqueueInput,
  TypedEnqueuePayload,
  TypedEnqueueResult,
  RequestOptions,
  Job,
  JobStatus,
  StorageJobStatus,
  JobError,
  JobAttempt,
  BackoffStrategy,
  CallbackStatus,
  JobClaim,
  JobContext,
  HandlerFn,
  WorkerRecord,
  WorkerState,
  WorkerLease,
  WorkerRegisterParams,
  ClaimParams,
  CompleteJobResponse,
  FailJobParams,
  FailJobResponse,
  HeartbeatResponse,
  RenewLeaseResponse,
  DeregisterWorkerResponse,
  JsonValue,
} from './types.js';

export type {
  BuiltInHandlers,
  HttpRequestPayload,
  HttpRequestResult,
  SendEmailPayload,
  SendEmailResult,
  NoopPayload,
  NoopResult,
  HandlerDefinition,
  HandlerConfig,
  HandlerContract,
  HandlerMap,
  DefinitionPayload,
  DefinitionResult,
  HandlerName,
  HandlerPayload,
  HandlerResult,
  HandlerPayloadFor,
  HandlerResultFor,
  ResolvedHandlers,
} from './handlers.js';

export type {
  StandardSchemaV1,
  StaticSchema,
  SchemaLike,
  InferSchemaOutput,
} from './standard-schema.js';

export type {
  WebhookEvent,
  WebhookJobStatus,
  WebhookVerificationOptions,
} from './webhook.js';

export type { VeyraApiErrorParams } from './errors.js';
