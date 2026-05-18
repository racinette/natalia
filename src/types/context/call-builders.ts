import type { StandardSchemaV1 } from "../standard-schema";
import type { ChannelDefinitions } from "../definitions/primitives";
import type { ErrorDefinitions } from "../definitions/errors";
import type { QueueEnqueueOptions } from "../definitions/messaging";
import type { RetentionSetter, WorkflowInvocationBaseOptions } from "../definitions/policies";
import type { AnyWorkflowHeader } from "../definitions/workflow-headers";
import type { RetryPolicyOptions } from "../definitions/policies";
import type { ErrorValue, WorkflowResult } from "../results";
import type { RequestEntry, SchemaInvocationInput, StepBoundary, TimeoutResult, WorkflowEntry } from "./entries";

// =============================================================================
// FOREIGN WORKFLOW HANDLE
//
// A handle to a globally addressable workflow instance. Returned by
// `ctx.external.X.get(...)` and by `ctx.children.detached.X(...)`.
// Send-only — no awaitable result, no lifecycle control.
// =============================================================================

declare const nataliaAttachedChildWorkflowEntryBrand: unique symbol;

/**
 * Channel-send surface on a handle to a running workflow.
 *
 * Exposed on **detached / foreign** handles (`ForeignWorkflowHandle`), on
 * **`AttachedChildWorkflowScopeHandle`** inside `ctx.scope` bodies, and on
 * operator introspection handles where the type allows.
 *
 * The **direct** return value of `ctx.children.attached.X(...)` in the workflow
 * body is await-only (`AttachedChildWorkflowEntry`) — it intentionally does
 * **not** intersect this surface; message the child from the parent body only
 * via a scope entry + `handles.*.channels.*.send` while the child runs.
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
 * A limited handle to an existing (non-child or detached) workflow instance.
 *
 * Returned by `ctx.external.X.get(...)` and by
 * `ctx.children.detached.X(...)`. Send-only: `channels.X.send` plus
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
// Child workflow accessors live on `ctx.children.attached` (execution +
// compensation) and `ctx.children.detached`. Attached execution calls return
// `AttachedChildWorkflowEntry` (await-only). Scope bodies receive
// `AttachedChildWorkflowScopeHandle` (await + channels). Detached starts return
// `ForeignWorkflowHandle<W>`.
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
 * Optional invocation extras for attached child workflow calls (metadata,
 * seed). Workflow args are the first call argument, like `ctx.steps.X(args)`.
 *
 * `idempotencyKey` is omitted — attached children are parent-scoped, not
 * globally keyed.
 */
export type AttachedChildWorkflowStartOptions<W extends AnyWorkflowHeader> = {
  readonly metadata?: InferWorkflowMetadataInput<W>;
  readonly seed?: string;
};

export type AttachedChildWorkflowTimeoutInvocationOptions<W extends AnyWorkflowHeader> =
  ChildWorkflowTimeoutCallOptions & AttachedChildWorkflowStartOptions<W>;

/**
 * Invocation options for detached child workflow starts. Workflow args are
 * the first call argument; this bag carries `idempotencyKey`, metadata, seed,
 * and retention. Detached children may override retention independently from
 * the parent.
 */
export type DetachedChildWorkflowInvocationOptions<W extends AnyWorkflowHeader> = {
  readonly idempotencyKey?: string;
  readonly metadata?: InferWorkflowMetadataInput<W>;
  readonly seed?: string;
  readonly retention?: number | RetentionSetter<"complete" | "failed" | "terminated">;
};

/** @deprecated Use `DetachedChildWorkflowInvocationOptions` — args are no longer nested here. */
export type DetachedStartOptions<W extends AnyWorkflowHeader> =
  DetachedChildWorkflowInvocationOptions<W>;

/**
 * Optional invocation extras for attached child calls in compensation blocks.
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
 * The unstarted attached child workflow entry returned by
 * `ctx.children.attached.X(args, opts?)`.
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

interface ChildWorkflowAccessorWithArgs<
  W extends AnyWorkflowHeader,
  TArgsSchema extends StandardSchemaV1<unknown, unknown>,
> {
  (
    args: SchemaInvocationInput<TArgsSchema>,
  ): AttachedChildWorkflowEntry<W, AttachedChildWorkflowAwaited<W>>;

  (
    args: SchemaInvocationInput<TArgsSchema>,
    opts: AttachedChildWorkflowTimeoutInvocationOptions<W>,
  ): AttachedChildWorkflowEntry<W, AttachedChildWorkflowTimedAwaited<W>>;
}

interface ChildWorkflowAccessorNoArgs<W extends AnyWorkflowHeader> {
  (): AttachedChildWorkflowEntry<W, AttachedChildWorkflowAwaited<W>>;

  (
    opts: AttachedChildWorkflowTimeoutInvocationOptions<W>,
  ): AttachedChildWorkflowEntry<W, AttachedChildWorkflowTimedAwaited<W>>;
}

/**
 * Callable child workflow accessor on `ctx.children.attached` in
 * `WorkflowContext`.
 *
 * Workflow args are the first argument (same shape as `ctx.steps.X(args)`).
 * When the child declares no `args` schema, call with `()` instead.
 *
 * - `(args)` — success-or-failure union (no timeout variant).
 * - `(args, { timeout, ... })` — adds `{ ok: false; status: "timeout" }`.
 *
 * Child workflows are not retried by the parent; configure retry/backoff at
 * the child workflow definition level if needed.
 */
export type ChildWorkflowAccessor<W extends AnyWorkflowHeader> =
  InferWorkflowArgsSchema<W> extends StandardSchemaV1<unknown, unknown>
    ? ChildWorkflowAccessorWithArgs<W, InferWorkflowArgsSchema<W>>
    : ChildWorkflowAccessorNoArgs<W>;

interface DetachedChildWorkflowAccessorWithArgs<
  W extends AnyWorkflowHeader,
  TArgsSchema extends StandardSchemaV1<unknown, unknown>,
> {
  (
    args: SchemaInvocationInput<TArgsSchema>,
    opts: DetachedChildWorkflowInvocationOptions<W>,
  ): ForeignWorkflowHandle<InferWorkflowChannels<W>>;
}

interface DetachedChildWorkflowAccessorNoArgs<W extends AnyWorkflowHeader> {
  (
    opts: DetachedChildWorkflowInvocationOptions<W>,
  ): ForeignWorkflowHandle<InferWorkflowChannels<W>>;
}

/**
 * Callable child workflow accessor on `ctx.children.detached`.
 *
 * Workflow args are the first argument (like `ctx.steps.X(args)` and
 * `ctx.children.attached.X(args)`). When the child declares no `args` schema,
 * call with a single options bag: `ctx.children.detached.X({ idempotencyKey })`.
 *
 * Detached starts are buffered and synchronous; they return a
 * `ForeignWorkflowHandle` immediately. Detached children run independently of
 * the parent's lifecycle.
 */
export type DetachedChildWorkflowAccessor<W extends AnyWorkflowHeader> =
  InferWorkflowArgsSchema<W> extends StandardSchemaV1<unknown, unknown>
    ? DetachedChildWorkflowAccessorWithArgs<W, InferWorkflowArgsSchema<W>>
    : DetachedChildWorkflowAccessorNoArgs<W>;

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
 * Callable child workflow accessor on `ctx.children.attached` in
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
export interface QueueAccessor<TMessageSchema extends StandardSchemaV1> {
  enqueue(message: SchemaInvocationInput<TMessageSchema>, opts?: QueueEnqueueOptions): void;
}

// =============================================================================
// FOREIGN WORKFLOW ACCESSOR
// =============================================================================

/**
 * External workflow accessor on `ctx.external` in `WorkflowContext`.
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

type InferWorkflowArgsSchema<W> = W extends { args?: infer TArgSchema }
  ? TArgSchema extends StandardSchemaV1<unknown, unknown>
    ? TArgSchema
    : never
  : never;

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
