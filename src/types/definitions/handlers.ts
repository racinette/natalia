import type { JsonInput } from "../json-input";
import type {
  QueueHandlerError,
  QueueHandlerErrorOptions,
} from "../results";
import type { RetryPolicyOptions } from "./policies";
import type { RequestCompensationInfo } from "./steps";

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
 * `TTyped` is `never` when the queue definition omits `error` — `ctx.error`
 * then has no `typed` field. When an `error` schema is declared, `typed` is
 * optional and validated against that schema.
 */
export interface QueueHandlerContext<TTyped = never> extends HandlerContext {
  /**
   * Build a throwable queue handler error. Throw the return value to record an
   * attempt and apply `deadLetter` disposition.
   */
  error(options: QueueHandlerErrorOptions<TTyped>): QueueHandlerError<TTyped>;
}

/**
 * Retry policy for queue handler registration.
 *
 * `maxAttempts: null` retries without an attempt cap until success, message
 * expiry (`ttl_expired`), or `ctx.error({ deadLetter: true })`.
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
