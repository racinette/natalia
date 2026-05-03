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
 * Channel-send surface on a handle to a running workflow.
 *
 * Every kind of handle that points at a running workflow exposes this surface
 * (attached child entries inside the workflow body, detached / foreign
 * workflow handles outside it). Send is a buffered operation — returns plain
 * `void`; the message is visible to the receiving workflow only after the
 * caller's next batch commit.
 */
export interface ChannelSendSurface<
  TChannels extends ChannelDefinitions = Record<string, never>,
> {
  readonly channels: {
    [K in keyof TChannels]: {
      send(data: StandardSchemaV1.InferInput<TChannels[K]>): void;
    };
  };
}

/**
 * A limited handle to an existing (non-child or detached) workflow instance.
 *
 * Returned by `ctx.foreignWorkflows.X.get(...)` and by
 * `ctx.childWorkflows.X.startDetached(...)`. Send-only: `channels.X.send` plus
 * the workflow's `idempotencyKey`. No awaitable result; no lifecycle control.
 */
export interface ForeignWorkflowHandle<
  TChannels extends ChannelDefinitions = Record<string, never>,
> extends ChannelSendSurface<TChannels> {
  readonly idempotencyKey: string;
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
 * Result type for an attached child workflow entry awaited inside the parent
 * body. Per REFACTOR.MD Part 5, attached child failure is structurally
 * possible and must be handled in ordinary code.
 */
export type AttachedChildWorkflowResult<T, TError = unknown> =
  | { ok: true; result: T }
  | { ok: false; status: "failed"; error: TError };

/**
 * The unstarted attached child workflow entry returned by
 * `ctx.childWorkflows.X(startOpts, opts?)`.
 *
 * Awaitable for the success/failure (and optionally timeout) union AND
 * exposes the child's declared channel-send surface — the parent body may
 * push messages while the child is running. Attached children have no
 * `idempotencyKey` (they are not globally addressable).
 */
export type AttachedChildWorkflowEntry<
  W extends AnyWorkflowHeader,
  TAwaited,
> = WorkflowEntry<TAwaited> & ChannelSendSurface<InferWorkflowChannels<W>>;

/**
 * Callable child workflow accessor on `ctx.childWorkflows` in
 * `WorkflowContext`.
 *
 * Two call overloads:
 * - `(opts)` — dispatches the attached child; the awaited value is a
 *   success-or-failure union (no timeout variant).
 * - `(opts, { timeout })` — dispatches with an observation timeout; the
 *   awaited value adds a `{ ok: false; status: "timeout" }` variant.
 *
 * Child workflows are not retried by the parent; configure retry/backoff at
 * the child workflow definition level if needed.
 *
 * `startDetached` is a buffered operation that starts the child as a
 * globally addressable root workflow and returns a `ForeignWorkflowHandle`.
 *
 * @typeParam W - The child workflow definition.
 * @typeParam Tctx - The parent workflow's CompensationContext type
 *   (preserved for callsite type inference).
 */
export interface ChildWorkflowAccessor<
  W extends AnyWorkflowHeader,
  Tctx = unknown,
> {
  (
    options: AttachedChildWorkflowStartOptions<W>,
  ): AttachedChildWorkflowEntry<
    W,
    AttachedChildWorkflowResult<
      InferWorkflowResult<W>,
      ErrorValue<InferWorkflowErrors<W>>
    >
  >;

  (
    options: AttachedChildWorkflowStartOptions<W>,
    opts: ChildWorkflowTimeoutCallOptions,
  ): AttachedChildWorkflowEntry<
    W,
    | AttachedChildWorkflowResult<
        InferWorkflowResult<W>,
        ErrorValue<InferWorkflowErrors<W>>
      >
    | { ok: false; status: "timeout" }
  >;

  /**
   * Start this child workflow in detached mode — buffered, synchronous,
   * returns a `ForeignWorkflowHandle` immediately. The child runs
   * independently of the parent's lifecycle.
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

/**
 * Call options for a request. `priority` is optional (default 0); `timeout`
 * is required when an options bag is supplied. Without an options bag the
 * request waits indefinitely.
 *
 * Requests delegate resolution; the workflow does not own the resolution
 * implementation, so configuration of retries, deadlines, and
 * exhaustion-fallbacks lives on the handler registration — not here.
 */
export interface RequestCallOptions {
  readonly priority?: number;
  readonly timeout: StepBoundary;
}

export interface RequestAccessor<
  TPayloadSchema extends StandardSchemaV1,
  TResponse,
> {
  (payload: SchemaInvocationInput<TPayloadSchema>): RequestEntry<TResponse>;
  (
    payload: SchemaInvocationInput<TPayloadSchema>,
    opts: RequestCallOptions,
  ): RequestEntry<TimeoutResult<TResponse>>;
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
