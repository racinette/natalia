import type { ErrorDefinitions } from "./errors";
import type { RequestCompensationInfo } from "./steps";
import type {
  QueueErrorFactories,
  QueueHandlerAttemptAccessor,
  RequestErrorFactories,
} from "../results";
import type { DeadLetterReason } from "../schema";
import type { RetryPolicyOptions } from "./policies";

/**
 * Function returned by client/runtime handler registration APIs.
 */
export type Unsubscribe = () => void;

/**
 * Runtime opts passed to externalWorkflows handlers (abort signal per attempt).
 */
export interface HandlerContext {
  readonly signal: AbortSignal;
}

/**
 * Queue handler context.
 *
 * When the queue declares an `errors` map, `ctx.errors` exposes a factory per
 * code. Queues with no declared errors omit usable factories — only unhandled
 * throws remain.
 */
export interface QueueHandlerContext<
  TErrors extends ErrorDefinitions = Record<string, never>,
> extends HandlerContext {
  readonly errors: QueueErrorFactories<TErrors>;
}

/**
 * Retry policy for queue handler registration.
 *
 * `maxAttempts: null` retries without an attempt cap until success, message
 * expiry (`ttl_expired`), or `throw ctx.errors.X(..., { deadLetter: true })`.
 */
export interface QueueHandlerRetryPolicy extends RetryPolicyOptions {
  readonly maxAttempts: number | null;
}

/**
 * Terminal queue message status passed to {@link QueueRetentionPolicy} at
 * finalize time (after processing succeeds or the message is dead-lettered).
 */
export type QueueTerminalStatus = "processed" | "dead_lettered";

/**
 * Context for {@link QueueRetentionPolicy} — terminal row snapshot plus lazy
 * access to persisted handler attempt records. The engine invokes the policy
 * once when the message becomes terminal; `null` retains the row forever.
 */
export type QueueRetentionContext<
  TErrors extends ErrorDefinitions = Record<string, never>,
  TMessage = unknown,
> = {
  readonly status: QueueTerminalStatus;
  /** Set when `status === "dead_lettered"`; `null` when processed successfully. */
  readonly reason: DeadLetterReason | null;
  readonly message: TMessage;
  readonly attempts: QueueHandlerAttemptAccessor<TErrors>;
};

/**
 * Assigns row retention in seconds from finalize time, or `null` to keep forever.
 *
 * Should depend only on {@link QueueRetentionContext} (terminal message and
 * attempt history). The engine runs this once per terminal message before
 * persisting `retention_deadline_at`.
 */
export type QueueRetentionPolicy<
  TErrors extends ErrorDefinitions = Record<string, never>,
  TMessage = unknown,
> = (ctx: QueueRetentionContext<TErrors, TMessage>) => Promise<number | null>;

/**
 * Request handler context.
 *
 * When the request declares an `errors` map, `ctx.errors` exposes a factory per
 * code. Requests with no declared errors omit usable factories — only unhandled
 * throws remain.
 */
export interface RequestHandlerContext<
  TErrors extends ErrorDefinitions = Record<string, never>,
> extends HandlerContext {
  readonly errors: RequestErrorFactories<TErrors>;
}

/**
 * Request compensation handler context — uses the compensation block's own
 * `errors` map, not the forward request handler's.
 */
export interface RequestCompensationHandlerContext<
  TErrors extends ErrorDefinitions = Record<string, never>,
> extends HandlerContext {
  readonly errors: RequestErrorFactories<TErrors>;
}

/**
 * Retry policy for forward request handler registration.
 *
 * `maxAttempts: null` retries without an attempt cap until the handler returns
 * a response, the workflow call times out, or `throw ctx.errors.X(..., {
 * manual: true })`.
 */
export interface RequestHandlerRetryPolicy extends RetryPolicyOptions {
  readonly maxAttempts?: number | null;
  readonly totalTimeoutSeconds?: number;
}

/**
 * Client-side forward request handler registration options.
 */
export interface RequestHandlerRegistrationOptions<
  TErrors extends ErrorDefinitions = Record<string, never>,
  TPayload = unknown,
  TResponse = unknown,
> {
  readonly retryPolicy?: RequestHandlerRetryPolicy;
  readonly maxConcurrent?: number;
  readonly onExhausted?: {
    readonly callback: (
      payload: TPayload,
      opts: RequestHandlerContext<TErrors>,
    ) => Promise<TResponse>;
    readonly retryPolicy: RequestForwardOnExhaustedRetryOptions;
  };
}

export interface RequestForwardOnExhaustedRetryOptions {
  readonly intervalMs: number;
  readonly backoffRate?: number;
  readonly maxIntervalMs?: number;
}

/**
 * Topic consumer context.
 */
export type TopicConsumerContext = HandlerContext;

/**
 * Options for externalWorkflows retried handlers.
 */
export interface HandlerRetryOptions extends RetryPolicyOptions {
  readonly maxAttempts?: number;
}

export interface RequestCompensationRetryOptions extends HandlerRetryOptions {
  readonly totalTimeoutSeconds?: number;
}

export interface RequestCompensationOnExhaustedRetryOptions {
  readonly intervalMs: number;
  readonly backoffRate?: number;
  readonly maxIntervalMs?: number;
}

export interface RequestCompensationHandlerOptions<
  TPayload = unknown,
  TResponse = unknown,
  TResult = void,
  TCompensationErrors extends ErrorDefinitions = Record<string, never>,
> {
  readonly maxConcurrent?: number;
  readonly retryPolicy: RequestCompensationRetryOptions;
  readonly onExhausted?: {
    readonly callback: (
      payload: TPayload,
      info: RequestCompensationInfo<TResponse>,
      opts: RequestCompensationHandlerContext<TCompensationErrors>,
    ) => Promise<TResult>;
    readonly retryPolicy: RequestCompensationOnExhaustedRetryOptions;
  };
}
