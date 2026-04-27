import type { StandardSchemaV1 } from "../standard-schema";
import type { ChannelDefinitions } from "../definitions/primitives";
import type { ErrorDefinitions } from "../definitions/errors";
import type { RetentionSetter, WorkflowInvocationBaseOptions } from "../definitions/policies";
import type { AnyWorkflowHeader, WorkflowDefinitions } from "../definitions/workflow-headers";
import type { RetryPolicyOptions } from "../definitions/policies";
import type { StepDefinitions } from "../definitions/steps";
import type {
  ChildWorkflowCompensationResult,
  CompensationStepResult,
  ErrorValue,
  StepCompensationResult,
  WorkflowResult,
} from "../results";
import type { AllBranchesFailedInfo, ChildWorkflowFailureInfo, ScopeFailureInfo, StepFailureInfo } from "./failures";
import type { AtomicResult, CompensationRoot, DurableHandle, ExecutionRoot, RootScope } from "./deterministic-handles";
import type { AwaitableEntry, RequestEntry, SchemaInvocationInput, StepBoundary, TimeoutResult, WorkflowEntry } from "./entries";
import type { ScopeEntry } from "./scope-results";

// =============================================================================
// STEP CALL — THENABLE BUILDER (WorkflowContext)
// =============================================================================

/**
 * Thenable returned by calling a step in WorkflowContext.
 *
 * Chain builder methods before awaiting:
 * - `.compensate()` — register compensation callback (switches HasCompensation to true)
 * - `.retry()` — override retry policy
 * - `.failure()` — handle failure explicitly instead of auto-terminating; return TFail
 * - `.complete()` — transform success result
 *
 * Await the call via `stepCall.resolve(ctx)` to resolve to `T | TFail`.
 *
 * @typeParam T - Decoded step result type (z.output<Schema>).
 * @typeParam TFail - Return type of the `.failure()` callback (never if not used).
 * @typeParam HasCompensation - Whether `.compensate()` has been called.
 * @typeParam Tctx - The CompensationContext type for this workflow.
 */
export interface StepCall<
  T,
  TFail = never,
  HasCompensation extends boolean = false,
  Tctx = unknown,
> extends DurableHandle<T | TFail, ExecutionRoot> {
  /**
   * Register a compensation callback for this step.
   * Runs during LIFO unwinding when the workflow fails.
   */
  compensate(
    cb: (ctx: Tctx, result: StepCompensationResult<T>) => Promise<void>,
  ): StepCall<T, TFail, true, Tctx>;

  /**
   * Override the step's retry policy.
   */
  retry(policy: RetryPolicyOptions): StepCall<T, TFail, HasCompensation, Tctx>;

  /**
   * Handle step failure explicitly — the workflow does NOT auto-terminate.
   * The callback return value becomes TFail in the resolved union.
   */
  failure<R>(
    cb: (failure: StepFailureInfo) => R,
  ): StepCall<T, Awaited<R>, HasCompensation, Tctx>;

  /**
   * Transform the success result.
   * The callback return value replaces T in the resolved type.
   */
  complete<R>(
    cb: (data: T) => R,
  ): StepCall<Awaited<R>, TFail, HasCompensation, Tctx>;
}

// =============================================================================
// COMPENSATION STEP CALL — THENABLE (CompensationContext)
// =============================================================================

/**
 * Thenable returned by calling a step in CompensationContext.
 *
 * Always resolves to `CompensationStepResult<T>` — compensation code MUST
 * handle both ok and !ok cases gracefully.
 *
 * Only `.retry()` is available — no `.compensate()` (can't nest compensations),
 * no `.failure()` (failures are in the result union).
 *
 * @typeParam T - Decoded step result type (z.output<Schema>).
 */
export interface CompensationStepCall<T> extends DurableHandle<
  CompensationStepResult<T>,
  CompensationRoot
> {
  /**
   * Override the step's retry policy.
   */
  retry(policy: RetryPolicyOptions): CompensationStepCall<T>;
}

// =============================================================================
// FOREIGN WORKFLOW HANDLE
// =============================================================================

/**
 * A limited handle to an existing (non-child) workflow instance.
 * Only channels.send() is available — prevents tight coupling.
 * Send is fire-and-forget: returns void, no delivery confirmation.
 */
export interface ForeignWorkflowHandle<
  TChannels extends ChannelDefinitions = Record<string, never>,
> {
  readonly idempotencyKey: string;

  /**
   * Channels for sending messages to this workflow.
   * Fire-and-forget: returns void.
   */
  readonly channels: {
    [K in keyof TChannels]: {
      send(data: StandardSchemaV1.InferInput<TChannels[K]>): AtomicResult<void>;
    };
  };
}

// =============================================================================
// WORKFLOW CALL — THENABLE BUILDER (WorkflowContext)
// =============================================================================

/**
 * Thenable returned after applying at least one result-mode builder
 * (`.compensate()`, `.failure()`, `.complete()`) on a `WorkflowCall`.
 *
 * @typeParam T - Decoded child workflow result type.
 * @typeParam TFail - Return type of the `.failure()` callback (never if not used).
 * @typeParam HasCompensation - Whether `.compensate()` has been called.
 * @typeParam Tctx - The CompensationContext type for the parent workflow.
 */
export interface WorkflowCallResult<
  T,
  TFail = never,
  HasCompensation extends boolean = false,
  Tctx = unknown,
> extends DurableHandle<T | TFail, ExecutionRoot> {
  /**
   * Register a compensation callback for this child workflow invocation.
   * Runs during LIFO unwinding when the parent workflow fails.
   */
  compensate(
    cb: (
      ctx: Tctx,
      result: ChildWorkflowCompensationResult<T>,
    ) => Promise<void>,
  ): WorkflowCallResult<T, TFail, true, Tctx>;

  /**
   * Handle child workflow failure explicitly — the parent does NOT auto-terminate.
   */
  failure<R>(
    cb: (failure: ChildWorkflowFailureInfo) => R,
  ): WorkflowCallResult<T, Awaited<R>, HasCompensation, Tctx>;

  /**
   * Transform the child workflow's success result.
   */
  complete<R>(
    cb: (data: T) => R,
  ): WorkflowCallResult<Awaited<R>, TFail, HasCompensation, Tctx>;
}

/**
 * Thenable returned by calling a child workflow accessor in WorkflowContext.
 *
 * Structured result mode for child workflow calls.
 *
 * Call the accessor with `{ detached: true }` to use detached messaging mode instead,
 * which returns a `ForeignWorkflowHandle` directly from the accessor call.
 *
 * @typeParam T - Decoded child workflow result type.
 * @typeParam TFail - Return type of `.failure()` callback (never if not used).
 * @typeParam HasCompensation - Whether `.compensate()` has been called.
 * @typeParam Tctx - The CompensationContext type for the parent workflow.
 */
export interface WorkflowCall<
  T,
  TFail = never,
  HasCompensation extends boolean = false,
  Tctx = unknown,
> extends DurableHandle<T | TFail, ExecutionRoot> {
  /**
   * Register a compensation callback.
   */
  compensate(
    cb: (
      ctx: Tctx,
      result: ChildWorkflowCompensationResult<T>,
    ) => Promise<void>,
  ): WorkflowCallResult<T, TFail, true, Tctx>;

  /**
   * Handle child workflow failure explicitly.
   */
  failure<R>(
    cb: (failure: ChildWorkflowFailureInfo) => R,
  ): WorkflowCallResult<T, Awaited<R>, HasCompensation, Tctx>;

  /**
   * Transform the child workflow's success result — enters result mode.
   */
  complete<R>(
    cb: (data: T) => R,
  ): WorkflowCallResult<Awaited<R>, TFail, HasCompensation, Tctx>;
}

export interface ScopeCall<
  T,
  TFail = never,
  TSteps extends StepDefinitions = StepDefinitions,
  TChildWorkflows extends WorkflowDefinitions = WorkflowDefinitions,
  TRoot extends RootScope = RootScope,
> extends DurableHandle<T | TFail, TRoot> {
  /**
   * Handle scope/all failure after the scope has fully unwound.
   */
  failure<R>(
    cb: (failure: ScopeFailureInfo<TSteps, TChildWorkflows>) => R,
  ): ScopeCall<T, Awaited<R>, TSteps, TChildWorkflows, TRoot>;
}

export interface FirstCall<
  T,
  E extends Record<string, ScopeEntry<any>>,
  TFail = never,
  TSteps extends StepDefinitions = StepDefinitions,
  TChildWorkflows extends WorkflowDefinitions = WorkflowDefinitions,
  TRoot extends RootScope = RootScope,
> extends DurableHandle<T | TFail, TRoot> {
  /**
   * Handle the "all branches failed" case for first().
   */
  failure<R>(
    cb: (failures: AllBranchesFailedInfo<E, TSteps, TChildWorkflows>) => R,
  ): FirstCall<T, E, Awaited<R>, TSteps, TChildWorkflows, TRoot>;
}

// =============================================================================
// COMPENSATION WORKFLOW CALL — THENABLE (CompensationContext)
// =============================================================================

/**
 * Thenable returned by calling a child workflow accessor in CompensationContext.
 * Always resolves to `WorkflowResult<T>` — compensation code MUST handle all outcomes.
 *
 * @typeParam T - Decoded child workflow result type.
 */
export interface CompensationWorkflowCall<T> extends DurableHandle<
  WorkflowResult<T>,
  CompensationRoot
> {}

// =============================================================================
// WORKFLOW ACCESSORS (CONTEXT-SPECIFIC)
// =============================================================================

/**
 * Base start options for a child workflow call.
 */
export type ChildWorkflowStartOptions<W extends AnyWorkflowHeader> =
  WorkflowInvocationBaseOptions<
    InferWorkflowArgsInput<W>,
    InferWorkflowMetadataInput<W>
  >;

export interface ChildWorkflowCallOptions {
  readonly retry?: RetryPolicyOptions;
}

export interface ChildWorkflowTimeoutCallOptions extends ChildWorkflowCallOptions {
  readonly timeout: StepBoundary;
}

/**
 * Child workflow start options in attached mode.
 * Retention is inherited from the parent workflow.
 */
export type AttachedChildWorkflowStartOptions<W extends AnyWorkflowHeader> =
  ChildWorkflowStartOptions<W>;

/**
 * Child workflow start options in detached mode.
 * Detached children may override retention independently from the parent.
 * The `detached: true` flag is implied by calling `.startDetached()`.
 */
export type DetachedStartOptions<W extends AnyWorkflowHeader> =
  ChildWorkflowStartOptions<W> & {
    retention?: number | RetentionSetter<"complete" | "failed" | "terminated">;
  };

/**
 * Start options for child workflow calls in compensation context.
 */
export type CompensationChildWorkflowStartOptions<W extends AnyWorkflowHeader> =
  WorkflowInvocationBaseOptions<
    InferWorkflowArgsInput<W>,
    InferWorkflowMetadataInput<W>
  >;

/**
 * Callable child workflow accessor on `ctx.childWorkflows` in WorkflowContext.
 *
 * @typeParam W - The child workflow definition.
 * @typeParam Tctx - The parent workflow's CompensationContext type.
 */
export interface ChildWorkflowAccessor<
  W extends AnyWorkflowHeader,
  Tctx = unknown,
> {
  (
    options: AttachedChildWorkflowStartOptions<W>,
  ): WorkflowEntry<
    AttachedChildWorkflowResult<
      InferWorkflowResult<W>,
      ErrorValue<InferWorkflowErrors<W>>
    >
  >;

  (
    options: AttachedChildWorkflowStartOptions<W>,
    opts: ChildWorkflowTimeoutCallOptions,
  ): WorkflowEntry<
    | AttachedChildWorkflowResult<
        InferWorkflowResult<W>,
        ErrorValue<InferWorkflowErrors<W>>
      >
    | { ok: false; status: "timeout" }
  >;

  (
    options: AttachedChildWorkflowStartOptions<W>,
    opts: ChildWorkflowCallOptions,
  ): WorkflowEntry<
    AttachedChildWorkflowResult<
      InferWorkflowResult<W>,
      ErrorValue<InferWorkflowErrors<W>>
    >
  >;

  /**
   * Start this child workflow in detached mode.
   *
   * The child runs independently — the parent does not wait for its result and
   * lifecycle is not managed. Returns a `ForeignWorkflowHandle` for fire-and-forget
   * channel messaging.
   *
   * This is a buffered, synchronous-at-engine-level operation. It does not
   * create an awaitable scope entry and does not yield.
   */
  startDetached(
    options: DetachedStartOptions<W>,
  ): ForeignWorkflowHandle<InferWorkflowChannels<W>>;
}

export type AttachedChildWorkflowResult<T, TError = unknown> =
  | { ok: true; result: T }
  | { ok: false; status: "failed"; error: TError };

export interface RequestCallOptions {
  readonly priority?: number;
}

export interface RequestTimeoutCallOptions extends RequestCallOptions {
  readonly timeout: StepBoundary;
}

export interface RequestAccessor<
  TPayloadSchema extends StandardSchemaV1,
  TResponse,
> {
  (payload: SchemaInvocationInput<TPayloadSchema>): RequestEntry<TResponse>;
  (
    payload: SchemaInvocationInput<TPayloadSchema>,
    opts: RequestTimeoutCallOptions,
  ): RequestEntry<TimeoutResult<TResponse>>;
  (
    payload: SchemaInvocationInput<TPayloadSchema>,
    opts: RequestCallOptions,
  ): RequestEntry<TResponse>;
}

/**
 * Foreign workflow accessor on `ctx.foreignWorkflows` in WorkflowContext.
 *
 * Use `.get(idempotencyKey)` to obtain a `ForeignWorkflowHandle` for an existing
 * (non-child) workflow instance. Only `channels.send()` is available — no
 * events, streams, or lifecycle (prevents tight coupling).
 *
 * @typeParam W - The workflow definition (for channel type inference).
 */
export interface ForeignWorkflowAccessor<W extends AnyWorkflowHeader> {
  /**
   * Get a limited handle to an existing workflow instance.
   * Only channels.send() is available (fire-and-forget).
   *
   * @param idempotencyKey - The workflow idempotency key.
   */
  get(idempotencyKey: string): ForeignWorkflowHandle<InferWorkflowChannels<W>>;
}

/**
 * Callable child workflow accessor on `ctx.childWorkflows` in CompensationContext.
 * Returns full `WorkflowResult<T>` — compensation code must handle all outcomes.
 *
 * @typeParam W - The child workflow definition.
 */
export interface CompensationChildWorkflowAccessor<
  W extends AnyWorkflowHeader,
> {
  (
    options: CompensationChildWorkflowStartOptions<W>,
  ): WorkflowEntry<WorkflowResult<InferWorkflowResult<W>>>;
}

// =============================================================================
// TYPE HELPERS (workflow inference — used by context accessors above)
// =============================================================================

/**
 * Extract result type from a workflow definition or header (decoded — z.output).
 */
type InferWorkflowResult<W> = W extends {
  result?: infer TResultSchema;
}
  ? TResultSchema extends StandardSchemaV1<unknown, unknown>
    ? StandardSchemaV1.InferOutput<TResultSchema>
    : void
  : void;

/**
 * Extract channels from a workflow definition or header.
 */
type InferWorkflowChannels<W> = W extends {
  channels?: infer TChannels;
}
  ? TChannels extends ChannelDefinitions
    ? TChannels
    : Record<string, never>
  : Record<string, never>;

/**
 * Extract arg input type from a workflow definition or header (encoded — z.input).
 * Used for StartWorkflowOptions.args.
 */
type InferWorkflowArgsInput<W> = W extends { args?: infer TArgSchema }
  ? TArgSchema extends StandardSchemaV1<unknown, unknown>
    ? StandardSchemaV1.InferInput<TArgSchema>
    : void
  : void;

/**
 * Extract metadata input type from a workflow definition or header (encoded — z.input).
 * Used for StartWorkflowOptions.metadata.
 */
type InferWorkflowMetadataInput<W> = W extends {
  metadata?: infer TMetadataSchema;
}
  ? TMetadataSchema extends StandardSchemaV1<unknown, unknown>
    ? StandardSchemaV1.InferInput<TMetadataSchema>
    : void
  : void;

type InferWorkflowErrors<W> = W extends { errors?: infer TErrors }
  ? TErrors extends ErrorDefinitions
    ? TErrors
    : Record<string, never>
  : Record<string, never>;
