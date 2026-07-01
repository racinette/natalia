import type { ErrorDefinitions } from "./errors";
import type { RequestCompensationInfo } from "./steps";
import type {
  QueueErrorFactories,
  QueueHandlerAttemptAccessor,
  RequestErrorFactories,
  RequestHandlerAttemptAccessor,
  RequestManualEscalationErrorFactories,
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
 * Terminal forward request status passed to {@link RequestRetentionPolicy} at
 * finalize time. `manual` is not terminal — retention runs only after
 * `resolved`, `timedOut`.
 */
export type RequestTerminalStatus = "resolved" | "timedOut";

/**
 * Context for {@link RequestRetentionPolicy} — terminal row snapshot plus lazy
 * access to persisted handler attempt records. The engine invokes the policy
 * once when the invocation becomes terminal; `null` retains the row forever.
 */
export type RequestRetentionContext<
  TErrors extends ErrorDefinitions = Record<string, never>,
  TPayload = unknown,
  TResponse = unknown,
> =
  | {
      readonly status: "resolved";
      readonly payload: TPayload;
      readonly response: TResponse;
      readonly attempts: RequestHandlerAttemptAccessor<TErrors>;
    }
  | {
      readonly status: "timedOut";
      readonly payload: TPayload;
      readonly attempts: RequestHandlerAttemptAccessor<TErrors>;
    };

/**
 * Assigns row retention in seconds from finalize time, or `null` to keep forever.
 *
 * Should depend only on {@link RequestRetentionContext} (terminal payload,
 * response when resolved, and attempt history). The engine runs this once per
 * terminal invocation before persisting `retention_deadline_at`.
 */
export type RequestRetentionPolicy<
  TErrors extends ErrorDefinitions = Record<string, never>,
  TPayload = unknown,
  TResponse = unknown,
> = (
  ctx: RequestRetentionContext<TErrors, TPayload, TResponse>,
) => Promise<number | null>;

/**
 * Request handler context for the forward handler body (retried attempts).
 *
 * `ctx.errors` factories require `{ manual }` on every call.
 */
export interface RequestHandlerContext<
  TErrors extends ErrorDefinitions = Record<string, never>,
> extends HandlerContext {
  readonly errors: RequestErrorFactories<TErrors>;
}

/**
 * Request handler context for `onExhausted` — no retries; `return` resolves or
 * any `throw` (including `ctx.errors.X(...)`) moves to manual mode.
 */
export interface RequestOnExhaustedHandlerContext<
  TErrors extends ErrorDefinitions = Record<string, never>,
> extends HandlerContext {
  readonly errors: RequestManualEscalationErrorFactories<TErrors>;
}

/**
 * Request compensation handler context — uses the compensation block's own
 * `errors` map. `return` reports outcome; any `throw` moves to manual mode.
 */
export interface RequestCompensationHandlerContext<
  TErrors extends ErrorDefinitions = Record<string, never>,
> extends HandlerContext {
  readonly errors: RequestManualEscalationErrorFactories<TErrors>;
}

/**
 * Request compensation `onExhausted` context — same manual-only throw semantics
 * as {@link RequestOnExhaustedHandlerContext}.
 */
export interface RequestCompensationOnExhaustedHandlerContext<
  TErrors extends ErrorDefinitions = Record<string, never>,
> extends HandlerContext {
  readonly errors: RequestManualEscalationErrorFactories<TErrors>;
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
      opts: RequestOnExhaustedHandlerContext<TErrors>,
    ) => Promise<TResponse>;
  };
  readonly retentionPolicy?: RequestRetentionPolicy<TErrors, TPayload, TResponse>;
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
      opts: RequestCompensationOnExhaustedHandlerContext<TCompensationErrors>,
    ) => Promise<TResult>;
  };
}
