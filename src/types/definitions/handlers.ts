import type { JsonSchemaConstraint } from "../json-input";
import type { StandardSchemaV1 } from "../standard-schema";
import type { ErrorDefinitions } from "./errors";
import type { RequestCompensationConfig } from "./requests";
import type { RequestCompensationInfo } from "./steps";
import type {
  QueueErrorFactories,
  QueueHandlerAttempt,
  RequestErrorFactories,
  RequestHandlerAttempt,
} from "../results";
import type { DeadLetterReason } from "../schema";
import type { RetryPolicyOptions } from "./policies";
import type { HandlerAttemptsReadNamespace } from "../introspection";

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
 * Queue handler context for the handler body (retried attempts).
 *
 * The handler receives decoded `ctx.message`, `ctx.signal`, and `ctx.errors`.
 * When the queue declares an `errors` map, `ctx.errors` exposes a factory per
 * code. Queues with no declared errors omit usable factories — only unhandled
 * throws remain.
 */
export interface QueueHandlerContext<
  TErrors extends ErrorDefinitions = Record<string, never>,
  TMessage = unknown,
> extends HandlerContext {
  readonly message: TMessage;
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
  readonly attempts: HandlerAttemptsReadNamespace<
    QueueHandlerAttempt<TErrors>
  >;
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
      readonly attempts: HandlerAttemptsReadNamespace<
        RequestHandlerAttempt<TErrors>
      >;
    }
  | {
      readonly status: "timedOut";
      readonly payload: TPayload;
      readonly attempts: HandlerAttemptsReadNamespace<
        RequestHandlerAttempt<TErrors>
      >;
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
 * The handler receives decoded `ctx.payload`, `ctx.signal`, and `ctx.errors`.
 * `ctx.errors` factories require `{ manual }` on every call.
 */
export interface RequestHandlerContext<
  TErrors extends ErrorDefinitions = Record<string, never>,
  TPayload = unknown,
> extends HandlerContext {
  readonly payload: TPayload;
  readonly errors: RequestErrorFactories<TErrors>;
}

/**
 * Request compensation handler context — original payload, forward outcome,
 * and the compensation block's own `errors` map. `return` reports outcome;
 * `throw ctx.errors.X(..., { manual })` chooses retry vs manual escalation.
 */
export interface RequestCompensationHandlerContext<
  TCompensationErrors extends ErrorDefinitions = Record<string, never>,
  TPayload = unknown,
  TForwardResponse = unknown,
  TForwardErrors extends ErrorDefinitions = Record<string, never>,
> extends HandlerContext {
  readonly payload: TPayload;
  readonly forward: RequestCompensationInfo<TForwardResponse, TForwardErrors>;
  readonly errors: RequestErrorFactories<TCompensationErrors>;
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

export type RequestCompensationHandlerReturn<
  TCompensation extends RequestCompensationConfig<any, any>,
> = TCompensation extends RequestCompensationConfig<infer TResultSchema, any>
  ? TResultSchema extends StandardSchemaV1<unknown, unknown>
    ? StandardSchemaV1.InferInput<TResultSchema>
    : never
  : never;

/**
 * Compensation handler registration nested under
 * {@link RequestHandlerRegistrationOptions.compensation}.
 *
 * When `handler` is set, `retryPolicy` is required.
 */
export type RequestCompensationRegistrationOptions<
  TPayload = unknown,
  TForwardResponse = unknown,
  TCompensation extends RequestCompensationConfig<any, any> = RequestCompensationConfig<
    JsonSchemaConstraint,
    Record<string, never>
  >,
  TCompensationErrors extends ErrorDefinitions = Record<string, never>,
  TForwardErrors extends ErrorDefinitions = Record<string, never>,
> =
  | {
      readonly handler: (
        ctx: RequestCompensationHandlerContext<
          TCompensationErrors,
          TPayload,
          TForwardResponse,
          TForwardErrors
        >,
      ) => Promise<RequestCompensationHandlerReturn<TCompensation>>;
      readonly retryPolicy: RequestCompensationRetryOptions;
      readonly maxConcurrent?: number;
    }
  | {
      readonly handler?: never;
      readonly retryPolicy?: never;
      readonly maxConcurrent?: never;
    };

/**
 * Client-side forward request handler registration options.
 */
export type RequestHandlerRegistrationOptions<
  TErrors extends ErrorDefinitions = Record<string, never>,
  TPayload = unknown,
  TResponse = unknown,
  TCompensation extends RequestCompensationConfig<any, any> | undefined = undefined,
  TCompensationErrors extends ErrorDefinitions = Record<string, never>,
> = {
  readonly retryPolicy?: RequestHandlerRetryPolicy;
  readonly maxConcurrent?: number;
  readonly retentionPolicy?: RequestRetentionPolicy<TErrors, TPayload, TResponse>;
} & ([TCompensation] extends [undefined]
  ? { readonly compensation?: never }
  : {
      readonly compensation?: RequestCompensationRegistrationOptions<
        TPayload,
        TResponse,
        Extract<TCompensation, RequestCompensationConfig<any, any>>,
        TCompensationErrors,
        TErrors
      >;
    });

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
