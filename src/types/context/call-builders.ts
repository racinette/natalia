import type { StandardSchemaV1 } from "../standard-schema";
import type { ChannelDefinitions } from "../definitions/primitives";
import type { ErrorDefinitions } from "../definitions/errors";
import type { RetentionSetter, WorkflowInvocationBaseOptions } from "../definitions/policies";
import type { AnyWorkflowHeader, WorkflowDefinitions } from "../definitions/workflow-headers";
import type { RetryPolicyOptions } from "../definitions/policies";
import type { ErrorValue, WorkflowResult } from "../results";
import type { AtomicResult } from "./deterministic-handles";
import type { RequestEntry, SchemaInvocationInput, StepBoundary, TimeoutResult, WorkflowEntry } from "./entries";

// =============================================================================
// FOREIGN WORKFLOW HANDLE
//
// A handle to a globally addressable workflow instance. Returned by
// `ctx.foreignWorkflows.X.get(...)` and by `ctx.childWorkflows.X.startDetached(...)`.
// Send-only — no awaitable result, no lifecycle control.
// =============================================================================

/**
 * A limited handle to an existing (non-child or detached) workflow instance.
 *
 * Only `channels.X.send(...)` is available. Send is a buffered operation
 * (returns void at the public-API level — see step 01 for the buffered/
 * dispatched/awaitable taxonomy).
 */
export interface ForeignWorkflowHandle<
  TChannels extends ChannelDefinitions = Record<string, never>,
> {
  readonly idempotencyKey: string;

  readonly channels: {
    [K in keyof TChannels]: {
      send(data: StandardSchemaV1.InferInput<TChannels[K]>): AtomicResult<void>;
    };
  };
}

// =============================================================================
// CHILD WORKFLOW ACCESSORS
//
// Child workflow accessors live on `ctx.childWorkflows` (in execution
// context) and `ctx.childWorkflows` (in compensation context). They produce
// `WorkflowEntry<T>` for attached starts or `ForeignWorkflowHandle<W>` for
// detached starts.
//
// Step 01 keeps the existing accessor shapes; step 03 will revisit the
// attached-entry channel-send surface and call-time options.
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
 * Attached child workflow start options. Retention is inherited from the
 * parent workflow.
 */
export type AttachedChildWorkflowStartOptions<W extends AnyWorkflowHeader> =
  ChildWorkflowStartOptions<W>;

/**
 * Detached child workflow start options. Detached children may override
 * retention independently from the parent.
 */
export type DetachedStartOptions<W extends AnyWorkflowHeader> =
  ChildWorkflowStartOptions<W> & {
    retention?: number | RetentionSetter<"complete" | "failed" | "terminated">;
  };

/**
 * Compensation-context child workflow start options.
 */
export type CompensationChildWorkflowStartOptions<W extends AnyWorkflowHeader> =
  WorkflowInvocationBaseOptions<
    InferWorkflowArgsInput<W>,
    InferWorkflowMetadataInput<W>
  >;

/**
 * Result type for an attached child workflow entry. Step 01 keeps the
 * current shape; step 03 may extend it.
 */
export type AttachedChildWorkflowResult<T, TError = unknown> =
  | { ok: true; result: T }
  | { ok: false; status: "failed"; error: TError };

/**
 * Callable child workflow accessor on `ctx.childWorkflows` in
 * `WorkflowContext`.
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
   * Start this child workflow in detached mode. The child runs
   * independently; the parent does not wait for its result. Returns a
   * `ForeignWorkflowHandle` for fire-and-forget channel messaging.
   */
  startDetached(
    options: DetachedStartOptions<W>,
  ): ForeignWorkflowHandle<InferWorkflowChannels<W>>;
}

/**
 * Callable child workflow accessor on `ctx.childWorkflows` in
 * `CompensationContext`. Returns a `WorkflowEntry` whose awaited value is a
 * full `WorkflowResult<T>` — compensation must handle all outcomes.
 */
export interface CompensationChildWorkflowAccessor<
  W extends AnyWorkflowHeader,
> {
  (
    options: CompensationChildWorkflowStartOptions<W>,
  ): WorkflowEntry<WorkflowResult<InferWorkflowResult<W>>>;
}

// =============================================================================
// REQUEST ACCESSOR
// =============================================================================

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

// =============================================================================
// FOREIGN WORKFLOW ACCESSOR
// =============================================================================

/**
 * Foreign workflow accessor on `ctx.foreignWorkflows` in `WorkflowContext`.
 *
 * Use `.get(idempotencyKey)` to obtain a `ForeignWorkflowHandle` for an
 * existing workflow instance. Only `channels.send()` is available — no
 * events, streams, or lifecycle (prevents tight coupling).
 */
export interface ForeignWorkflowAccessor<W extends AnyWorkflowHeader> {
  get(idempotencyKey: string): ForeignWorkflowHandle<InferWorkflowChannels<W>>;
}

// =============================================================================
// TYPE HELPERS (workflow inference — used by accessors above)
// =============================================================================

type InferWorkflowResult<W> = W extends {
  result?: infer TResultSchema;
}
  ? TResultSchema extends StandardSchemaV1<unknown, unknown>
    ? StandardSchemaV1.InferOutput<TResultSchema>
    : void
  : void;

type InferWorkflowChannels<W> = W extends {
  channels?: infer TChannels;
}
  ? TChannels extends ChannelDefinitions
    ? TChannels
    : Record<string, never>
  : Record<string, never>;

type InferWorkflowArgsInput<W> = W extends { args?: infer TArgSchema }
  ? TArgSchema extends StandardSchemaV1<unknown, unknown>
    ? StandardSchemaV1.InferInput<TArgSchema>
    : void
  : void;

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
