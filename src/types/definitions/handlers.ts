import type { ErrorDefinitions } from "./errors";
import type { RequestCompensationInfo } from "./steps";
import type { QueueErrorFactories } from "../results";
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
 * Request handler context.
 */
export type RequestHandlerContext = HandlerContext;

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
  TManual = unknown,
> {
  readonly maxConcurrent?: number;
  readonly retryPolicy: RequestCompensationRetryOptions;
  readonly onExhausted?: {
    readonly callback: (
      payload: TPayload,
      info: RequestCompensationInfo<TResponse>,
      opts: { signal: AbortSignal },
    ) => Promise<TResult | TManual>;
    readonly retryPolicy: RequestCompensationOnExhaustedRetryOptions;
  };
}
