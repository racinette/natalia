import type { RetryPolicyOptions } from "./policies";
import type { RequestCompensationInfo } from "./steps";

/**
 * Function returned by client/runtime handler registration APIs.
 */
export type Unsubscribe = () => void;

/**
 * Runtime context passed to external handlers.
 */
export interface HandlerContext {
  readonly signal: AbortSignal;
}

/**
 * Queue handler context.
 */
export interface QueueHandlerContext extends HandlerContext {}

/**
 * Request handler context.
 */
export interface RequestHandlerContext extends HandlerContext {}

/**
 * Topic consumer context.
 */
export interface TopicConsumerContext extends HandlerContext {}

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
      ctx: { signal: AbortSignal },
      payload: TPayload,
      info: RequestCompensationInfo<TResponse>,
    ) => Promise<TResult | TManual>;
    readonly retryPolicy: RequestCompensationOnExhaustedRetryOptions;
  };
}
