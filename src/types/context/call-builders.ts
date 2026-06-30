import type { StandardSchemaV1 } from "../standard-schema";
import type { ChannelDefinitions } from "../definitions/primitives";
import type {
  HasIdempotencyFactory,
  InferWorkflowArgsInput,
  InferWorkflowArgsSchema,
  InferWorkflowChannels,
  InferWorkflowErrors,
  InferWorkflowMetadataInput,
  InferWorkflowResult,
} from "../helpers";
import type { QueueEnqueueOptions, QueueEnqueueOptionsWithRequiredTtl } from "../definitions/messaging";
import type { DeadlineOptions, RetentionSetter } from "../definitions/policies";
import type { AnyWorkflowHeader } from "../definitions/workflow-headers";
import type { ErrorValue, WorkflowResult } from "../results";
import type { RequestEntry, SchemaInvocationInput, StepBoundary, TimeoutResult, WorkflowEntry } from "./entries";

// =============================================================================
// EXTERNAL WORKFLOW HANDLE
//
// A handle to a globally addressable independent workflow instance. Returned by
// `ctx.externalWorkflows.<name>.get(...)` and `.start(...)`.
// Send-only — no awaitable result, no lifecycle control.
// =============================================================================

declare const nataliaAttachedChildWorkflowEntryBrand: unique symbol;

/**
 * Channel-send surface on a handle to a running workflow.
 *
 * Exposed on **`ExternalWorkflowHandle`**, on **`AttachedChildWorkflowScopeHandle`**
 * inside `ctx.scope` bodies, and on operator introspection handles where the
 * type allows.
 *
 * The **direct** return value of `ctx.childWorkflows.<name>(...)` in the workflow
 * body is await-only (`AttachedChildWorkflowEntry`) — it intentionally does
 * **not** intersect this surface. Message a child from the parent body only via
 * a scope entry + `handles.*.channels.*.send` while the child runs.
 *
 * Send is a buffered operation — returns plain `void`; the message is visible
 * to the receiving workflow only after the caller's next batch commit.
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
 * A limited handle to an independent (root) workflow instance.
 *
 * Returned by `ctx.externalWorkflows.<name>.get(...)` and `.start(...)`.
 * Send-only: `channels.<name>.send(...)` plus the workflow's `idempotencyKey`.
 * No awaitable result; no lifecycle control.
 */
export interface ExternalWorkflowHandle<
  TChannels extends ChannelDefinitions = Record<string, never>,
> extends ChannelSendSurface<TChannels> {
  readonly idempotencyKey: string;
}

// =============================================================================
// CHILD WORKFLOW ACCESSORS
//
// `ctx.childWorkflows.<name>(...)` returns an `AttachedChildWorkflowEntry`
// (await-only). Scope bodies receive `AttachedChildWorkflowScopeHandle`
// (join + channels). Independent roots are started or referenced through
// `ctx.externalWorkflows.<name>.get/.start` → `ExternalWorkflowHandle`.
// =============================================================================

/**
 * Optional invocation extras for child workflow calls (metadata, seed, and an
 * optional execution deadline). Workflow args are the first call argument,
 * like `ctx.steps.X(args)`.
 *
 * `idempotencyKey` is omitted — child workflows are parent-scoped, not globally
 * keyed. To start an independent root, use `ctx.externalWorkflows.<name>.start`.
 */
export type AttachedChildWorkflowStartOptions<W extends AnyWorkflowHeader> = {
  readonly metadata?: InferWorkflowMetadataInput<W>;
  readonly seed?: string;
} & DeadlineOptions;

/**
 * Start options for attached child workflow calls in the execute body.
 */
export type ChildStartOptions<W extends AnyWorkflowHeader> = {
  readonly metadata?: InferWorkflowMetadataInput<W>;
  readonly seed?: string;
  readonly retention?: number | RetentionSetter<"complete" | "failed" | "terminated">;
} & DeadlineOptions;

/**
 * Optional invocation extras for child workflow calls in compensation blocks.
 */
export type CompensationChildWorkflowStartOptions<W extends AnyWorkflowHeader> =
  AttachedChildWorkflowStartOptions<W>;

/**
 * Result type for an attached child workflow entry awaited inside the parent
 * body. Per REFACTOR.MD Part 5, attached child failure is structurally
 * possible and must be handled in ordinary code.
 */
export type AttachedChildWorkflowResult<T, TError = unknown> =
  | { ok: true; result: T }
  | { ok: false; status: "failed"; error: TError };

/**
 * The unstarted child workflow entry returned by
 * `ctx.childWorkflows.<name>(args, opts?)`.
 *
 * **Await-only** in the parent body: use `await entry` (or pass the entry into
 * `ctx.scope` / join it from there) for the success/failure (and optional
 * timeout) union. Channel send to the child while it runs belongs on
 * `AttachedChildWorkflowScopeHandle` inside `ctx.scope`, not on this type.
 */
export interface AttachedChildWorkflowEntry<
  W extends AnyWorkflowHeader,
  TAwaited,
> extends WorkflowEntry<TAwaited> {
  readonly [nataliaAttachedChildWorkflowEntryBrand]?: InferWorkflowChannels<W>;
}

/**
 * Handle for an attached child passed as a scope entry — the child is
 * intentionally running for the scope body. Observe completion with
 * `ctx.join(handle)` from the scope callback (not `await handle` on this
 * surface). `channels.*.send` is available for the scope duration.
 */
export type AttachedChildWorkflowScopeHandle<
  W extends AnyWorkflowHeader,
  TAwaited,
> = AttachedChildWorkflowEntry<W, TAwaited> &
  ChannelSendSurface<InferWorkflowChannels<W>>;

type AttachedChildWorkflowAwaited<W extends AnyWorkflowHeader> =
  AttachedChildWorkflowResult<
    InferWorkflowResult<W>,
    ErrorValue<InferWorkflowErrors<W>>
  >;

type AttachedChildWorkflowTimedAwaited<W extends AnyWorkflowHeader> =
  | AttachedChildWorkflowAwaited<W>
  | { ok: false; status: "timeout" };

// =============================================================================
// CHILD WORKFLOW ACCESSOR
//
// One accessor per declared child on `ctx.childWorkflows.<name>`. The call
// returns an unstarted `AttachedChildWorkflowEntry` — parent-owned and
// awaitable. No `retry` (workflows are not retried). The execution deadline
// lives in call-time options; the join timeout lives on `ctx.join`.
// =============================================================================

/** Shared start options with an execution deadline made required. */
type ChildStartOptionsWithDeadline<W extends AnyWorkflowHeader> = {
  readonly metadata?: InferWorkflowMetadataInput<W>;
  readonly seed?: string;
  readonly retention?: number | RetentionSetter<"complete" | "failed" | "terminated">;
} & ({ readonly deadlineSeconds: number } | { readonly deadlineUntil: Date | number });

interface ChildWorkflowUnifiedAccessorWithArgs<
  W extends AnyWorkflowHeader,
  TArgsSchema extends StandardSchemaV1<unknown, unknown>,
> {
  (
    args: SchemaInvocationInput<TArgsSchema>,
  ): AttachedChildWorkflowEntry<W, AttachedChildWorkflowAwaited<W>>;

  (
    args: SchemaInvocationInput<TArgsSchema>,
    opts: ChildStartOptionsWithDeadline<W>,
  ): AttachedChildWorkflowEntry<W, AttachedChildWorkflowTimedAwaited<W>>;

  (
    args: SchemaInvocationInput<TArgsSchema>,
    opts: ChildStartOptions<W>,
  ): AttachedChildWorkflowEntry<W, AttachedChildWorkflowAwaited<W>>;
}

interface ChildWorkflowUnifiedAccessorNoArgs<W extends AnyWorkflowHeader> {
  (): AttachedChildWorkflowEntry<W, AttachedChildWorkflowAwaited<W>>;

  (
    opts: ChildStartOptionsWithDeadline<W>,
  ): AttachedChildWorkflowEntry<W, AttachedChildWorkflowTimedAwaited<W>>;

  (
    opts: ChildStartOptions<W>,
  ): AttachedChildWorkflowEntry<W, AttachedChildWorkflowAwaited<W>>;
}

/**
 * The unified child workflow accessor on `ctx.childWorkflows.<name>`.
 */
export type ChildWorkflowUnifiedAccessor<W extends AnyWorkflowHeader> =
  InferWorkflowArgsSchema<W> extends StandardSchemaV1<unknown, unknown>
    ? ChildWorkflowUnifiedAccessorWithArgs<W, InferWorkflowArgsSchema<W>>
    : ChildWorkflowUnifiedAccessorNoArgs<W>;

interface CompensationChildWorkflowAccessorWithArgs<
  W extends AnyWorkflowHeader,
  TArgsSchema extends StandardSchemaV1<unknown, unknown>,
> {
  (
    args: SchemaInvocationInput<TArgsSchema>,
    opts?: CompensationChildWorkflowStartOptions<W>,
  ): WorkflowEntry<WorkflowResult<InferWorkflowResult<W>>>;
}

interface CompensationChildWorkflowAccessorNoArgs<W extends AnyWorkflowHeader> {
  (
    opts?: CompensationChildWorkflowStartOptions<W>,
  ): WorkflowEntry<WorkflowResult<InferWorkflowResult<W>>>;
}

/**
 * Callable child workflow accessor on `ctx.childWorkflows.<name>` in
 * `CompensationContext`. Returns a `WorkflowEntry` whose awaited value is a
 * full `WorkflowResult<T>` — compensation must handle all outcomes.
 */
export type CompensationChildWorkflowAccessor<W extends AnyWorkflowHeader> =
  InferWorkflowArgsSchema<W> extends StandardSchemaV1<unknown, unknown>
    ? CompensationChildWorkflowAccessorWithArgs<W, InferWorkflowArgsSchema<W>>
    : CompensationChildWorkflowAccessorNoArgs<W>;

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
// QUEUE ACCESSOR
// =============================================================================

/**
 * Workflow-side accessor for enqueueing to a declared queue.
 *
 * `enqueue` is a synchronous buffered operation — returns `void`, not awaitable.
 */
export interface QueueAccessor<
  TMessageSchema extends StandardSchemaV1,
  THasDefaultTtl extends boolean = false,
> {
  enqueue(
    message: SchemaInvocationInput<TMessageSchema>,
    ...args: THasDefaultTtl extends true
      ? [opts?: QueueEnqueueOptions]
      : [opts: QueueEnqueueOptionsWithRequiredTtl]
  ): void;
}

// =============================================================================
// EXTERNAL WORKFLOW ACCESSOR
// =============================================================================

/**
 * Start options for `externalWorkflows.<name>.start(...)` — the shared start
 * options plus the identity key, made conditional on whether the workflow
 * declares an `idempotencyKeyFactory`: derived-from-args (not passable) when a
 * factory exists, required otherwise.
 */
export type ExternalWorkflowStartOptions<W extends AnyWorkflowHeader> = {
  readonly metadata?: InferWorkflowMetadataInput<W>;
  readonly seed?: string;
  readonly retention?: number | RetentionSetter<"complete" | "failed" | "terminated">;
} & DeadlineOptions &
  (HasIdempotencyFactory<W> extends true
    ? { readonly idempotencyKey?: never }
    : { readonly idempotencyKey: string });

interface ExternalWorkflowAccessorWithArgs<
  W extends AnyWorkflowHeader,
  TArgsSchema extends StandardSchemaV1<unknown, unknown>,
> {
  /**
   * Reference an existing independent workflow instance — by `args` when a
   * factory is declared (the engine derives the key), by `idempotencyKey`
   * otherwise.
   */
  get(
    ...lookup: HasIdempotencyFactory<W> extends true
      ? [args: SchemaInvocationInput<TArgsSchema>]
      : [idempotencyKey: string]
  ): ExternalWorkflowHandle<InferWorkflowChannels<W>>;

  /**
   * Start a new independent (root) workflow instance. Buffered/synchronous;
   * returns a send-only `ExternalWorkflowHandle`. The started workflow runs
   * independently of this one's lifecycle.
   */
  start(
    args: SchemaInvocationInput<TArgsSchema>,
    opts: ExternalWorkflowStartOptions<W>,
  ): ExternalWorkflowHandle<InferWorkflowChannels<W>>;
}

interface ExternalWorkflowAccessorNoArgs<W extends AnyWorkflowHeader> {
  get(
    ...lookup: HasIdempotencyFactory<W> extends true
      ? [args: InferWorkflowArgsInput<W>]
      : [idempotencyKey: string]
  ): ExternalWorkflowHandle<InferWorkflowChannels<W>>;

  start(
    opts: ExternalWorkflowStartOptions<W>,
  ): ExternalWorkflowHandle<InferWorkflowChannels<W>>;
}

/**
 * External workflow accessor on `ctx.externalWorkflows.<name>`.
 *
 * Two operations over **independent (root) workflow instances**, both yielding
 * a send-only `ExternalWorkflowHandle`:
 * - `get(...)` — reference an existing instance.
 * - `start(...)` — create a new one.
 */
export type ExternalWorkflowAccessor<W extends AnyWorkflowHeader> =
  InferWorkflowArgsSchema<W> extends StandardSchemaV1<unknown, unknown>
    ? ExternalWorkflowAccessorWithArgs<W, InferWorkflowArgsSchema<W>>
    : ExternalWorkflowAccessorNoArgs<W>;

