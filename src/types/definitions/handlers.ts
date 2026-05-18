import type { RetryPolicyOptions } from "./policies";
import type { RequestCompensationInfo } from "./steps";

/**
 * Function returned by client/runtime handler registration APIs.
 */
export type Unsubscribe = () => void;

/**
 * Runtime opts passed to external handlers (abort signal per attempt).
 */
export interface HandlerContext {
  readonly signal: AbortSignal;
}

/**
 * Queue handler context.
 */
export type QueueHandlerContext = HandlerContext;

declare const _deadLetterSentinel: unique symbol;

/**
 * Sentinel return for queue handlers that dead-letter a message immediately,
 * bypassing remaining retry attempts (analogous to `MANUAL` on request handlers).
 */
export const DEAD_LETTER: typeof _deadLetterSentinel =
  Symbol("DEAD_LETTER") as typeof _deadLetterSentinel;

export type DeadLetterSentinel = typeof DEAD_LETTER;

/** Result of a queue handler invocation. */
export type QueueHandlerResult = void | DeadLetterSentinel;

/**
 * Request handler context.
 */
export type RequestHandlerContext = HandlerContext;

/**
 * Topic consumer context.
 */
export type TopicConsumerContext = HandlerContext;

/**
 * Options for external retried handlers.
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
