import type {
  StepErrorAccessor,
  WorkflowExecutionError,
  WorkflowTerminationReason,
} from "./results";

// =============================================================================
// FAILURE INFO TYPES
// =============================================================================

/**
 * Failure information for a step, passed to `.failure()` builder callbacks
 * and concurrency primitive failure handlers.
 */
export interface StepFailureInfo {
  readonly reason: "attempts_exhausted" | "timeout";
  readonly errors: StepErrorAccessor;
}

/**
 * Failure information for a child workflow, passed to `.failure()` builder callbacks.
 * Discriminated union — the child may have failed (threw an error) or been
 * terminated for a non-failure reason (signal, parent termination, deadline).
 */
export type ChildWorkflowFailureInfo =
  | { readonly status: "failed"; readonly error: WorkflowExecutionError }
  | {
      readonly status: "terminated";
      readonly reason: WorkflowTerminationReason;
    };

/**
 * Augment a failure info type with a `compensate()` handle.
 *
 * `compensate()` invokes the compensation callback registered via `.compensate()`.
 * Calling it explicitly discharges the SAGA obligation for this handle — the engine
 * will NOT run the compensation again at scope exit.
 *
 * **Context switch:** Calling `compensate()` transparently switches the
 * execution context to compensation mode (SIGTERM-resilient). The compensation
 * callback runs to completion even if SIGTERM arrives mid-execution. Control
 * returns to the `failure` handler in normal WorkflowContext after.
 *
 * If `compensate()` is NOT called, the engine still runs the compensation at
 * scope exit / LIFO unwinding (the safe default).
 *
 * Only present when a `compensate` callback was registered. If no `compensate`
 * was provided, the failure object does not include `compensate` — full type safety.
 */
export type WithCompensation<T> = T & {
  readonly compensate: () => Promise<void>;
};

/**
 * Failure information for a scope branch, passed to `failure` callbacks in
 * forEach, map, and match handlers.
 *
 * Includes `compensate()` to eagerly discharge the LIFO compensation obligation
 * for any compensated steps registered within this branch. If not called, the
 * engine runs compensations at scope exit (safe default).
 */
export interface BranchFailureInfo {
  compensate(): Promise<void>;
  /**
   * Explicitly discharge the compensation obligation for this branch
   * WITHOUT running the compensation callback.
   * Use when you have already compensated externally, or the operation is
   * known to have had no effect and compensation is unnecessary.
   */
  dontCompensate(): void;
}

// =============================================================================
// CHANNEL HANDLE, STREAM ACCESSOR, EVENT ACCESSOR (WORKFLOW INTERNAL)
// =============================================================================

/**
 * Channel handle on ctx.channels.
 * Can be used directly for receive, passed into select, or async-iterated.
 * T is the decoded type (z.output<Schema>).
 */
export interface ChannelHandle<T> extends AsyncIterable<T> {
  /**
   * Receive a message from this channel (FIFO order).
   * Blocks until a message arrives. Returns the decoded value directly.
   */
  receive(): Promise<T>;

  /**
   * Async iteration over channel messages.
   *
   * Example:
   * `for await (const msg of ctx.channels.approval) { ... }`
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<T>;
}

/**
 * Stream accessor on ctx.streams (for writing from within the workflow).
 * T is the encoded type (z.input<Schema>).
 */
export interface StreamAccessor<T> {
  /**
   * Write a record to the stream.
   * @param data - Record data (z.input type — encoded).
   * @returns The offset at which the record was saved.
   */
  write(data: T): Promise<number>;
}

/**
 * Event accessor on ctx.events (for setting from within the workflow).
 */
export interface EventAccessor {
  /**
   * Set the event (idempotent — second call is no-op).
   */
  set(): Promise<void>;
}

// =============================================================================
// SCOPE TYPES — CLOSURES AND BRANCH HANDLES
// =============================================================================

/**
 * A scope branch — an async closure that runs on the virtual event loop.
 * Passed into `ctx.scope()` entries. The engine interleaves branch execution
 * at durable yield points (step calls, child workflow calls, channel receives, etc.).
 *
 * @typeParam T - The resolved value type of the branch.
 */
export type ScopeBranch<T> = () => Promise<T>;

/**
 * A scope entry value.
 *
 * Supports two forms:
 * - Closure form: `() => Promise<T>` (full flexibility, lazy execution)
 * - Direct thenable form: `PromiseLike<T>` (short-hand for common step/child calls)
 */
export type ScopeEntryValue<T> = ScopeBranch<T> | PromiseLike<T>;

/**
 * A handle to a running scope branch — awaitable in the scope callback.
 * Resolves to T when the branch completes successfully.
 *
 * `BranchHandle<T>` values are produced by `ctx.scope()` and can be:
 * - Directly awaited: `const result = await flight`
 * - Passed into `ctx.select()`, `ctx.forEach()`, `ctx.map()`
 * - Accumulated into collections for dynamic fan-out
 *
 * @typeParam T - The resolved value type.
 */
export interface BranchHandle<T> extends Promise<T> {}

/**
 * A group of branch handles — single, array, or map.
 * Used as input to `ctx.select()`, `ctx.forEach()`, and `ctx.map()`.
 *
 * - Single: `BranchHandle<T>` — one branch
 * - Array: `BranchHandle<T>[]` — N parallel branches
 * - Map: `Map<K, BranchHandle<T>>` — keyed parallel branches
 *
 * @typeParam T - The branch value type.
 * @typeParam K - The map key type (only relevant for Map variant).
 */
export type HandleGroup<T, K = any> =
  | BranchHandle<T>
  | BranchHandle<T>[]
  | Map<K, BranchHandle<T>>;

/**
 * Valid entry values for `ctx.scope()` declarations.
 * Each entry can be either:
 * - a closure (`() => Promise<T>`)
 * - a direct thenable (`PromiseLike<T>`)
 *
 * Collections (array/map) accept the same two forms per element.
 */
export type ScopeEntries = Record<
  string,
  ScopeEntryValue<any> | ScopeEntryValue<any>[] | Map<any, ScopeEntryValue<any>>
>;

/**
 * Extract resolved value type from a scope entry value.
 */
type ScopeEntryResult<V> = V extends (...args: any[]) => infer R
  ? Awaited<R>
  : Awaited<V>;

/**
 * Maps scope entry values to their corresponding branch handle types,
 * preserving collection structure (single → BranchHandle, array → array, map → map).
 */
export type ScopeHandles<E extends ScopeEntries> = {
  [K in keyof E]: E[K] extends ScopeEntryValue<any>
    ? BranchHandle<ScopeEntryResult<E[K]>>
    : E[K] extends (infer U)[]
      ? U extends ScopeEntryValue<any>
        ? BranchHandle<ScopeEntryResult<U>>[]
        : never
      : E[K] extends Map<infer MK, infer V>
        ? V extends ScopeEntryValue<any>
          ? Map<MK, BranchHandle<ScopeEntryResult<V>>>
          : never
        : never;
};

// =============================================================================
// SELECT — HANDLE TYPES
// =============================================================================

/**
 * Handle types that can be passed into ctx.select() (WorkflowContext and CompensationContext).
 * Includes BranchHandle collections for dynamic fan-out.
 */
export type SelectableHandle =
  | BranchHandle<any>
  | BranchHandle<any>[]
  | Map<any, BranchHandle<any>>
  | ChannelHandle<any>;

// =============================================================================
// SELECT — EVENT TYPES (WorkflowContext)
// =============================================================================

/**
 * Map a handle type to its select event result type.
 *
 * - BranchHandle: `{ key, status: "complete", data: T } | { key, status: "failed", failure }`
 * - BranchHandle[]: `{ key, innerKey: number, status: "complete", data: T } | { key, innerKey: number, status: "failed", failure }`
 * - Map<K, BranchHandle>: `{ key, innerKey: K, status: "complete", data: T } | { key, innerKey: K, status: "failed", failure }`
 * - ChannelHandle: `{ key, data: T }`
 */
export type HandleSelectEvent<K extends string, H> =
  H extends BranchHandle<infer T>
    ?
        | { key: K; status: "complete"; data: T }
        | { key: K; status: "failed"; failure: BranchFailureInfo }
    : H extends BranchHandle<infer T>[]
      ?
          | { key: K; innerKey: number; status: "complete"; data: T }
          | {
              key: K;
              innerKey: number;
              status: "failed";
              failure: BranchFailureInfo;
            }
      : H extends Map<infer MK, BranchHandle<infer T>>
        ?
            | { key: K; innerKey: MK; status: "complete"; data: T }
            | {
                key: K;
                innerKey: MK;
                status: "failed";
                failure: BranchFailureInfo;
              }
        : H extends ChannelHandle<infer T>
          ? { key: K; data: T }
          : never;

/**
 * What a match handler receives for a specific key.
 *
 * - BranchHandle<T>: `T` directly
 * - BranchHandle<T>[]: `{ data: T; innerKey: number }`
 * - Map<K, BranchHandle<T>>: `{ data: T; innerKey: K }`
 * - ChannelHandle<T>: `T` directly
 */
export type HandleMatchData<H> =
  H extends BranchHandle<infer T>
    ? T
    : H extends BranchHandle<infer T>[]
      ? { data: T; innerKey: number }
      : H extends Map<infer MK, BranchHandle<infer T>>
        ? { data: T; innerKey: MK }
        : H extends ChannelHandle<infer T>
          ? T
          : never;

/**
 * Union of all possible events from a select record.
 */
export type SelectEvent<M extends Record<string, SelectableHandle>> = {
  [K in keyof M & string]: HandleSelectEvent<K, M[K]>;
}[keyof M & string];

/**
 * Union of successful data values yielded by `for await...of` on a Selection.
 * Branch handles yield their result type T; channel handles yield their message type T.
 * For collections (array/map), the per-element data type is yielded.
 * A branch failure auto-terminates the workflow when iterating with `for await`.
 */
export type SelectDataUnion<M extends Record<string, SelectableHandle>> = {
  [K in keyof M & string]: BranchData<M[K]>;
}[keyof M & string];

// =============================================================================
// MATCH HELPERS
// =============================================================================

/**
 * Result of Selection.match().
 */
export type SelectMatchResult<T> =
  | { ok: true; status: "matched"; data: T }
  | { ok: false; status: "exhausted" };

/**
 * Extract the return type from a match/forEach/map handler entry.
 * Supports plain functions and `{ complete, failure }` objects.
 */
type ExtractHandlerReturn<H> = H extends (...args: any[]) => infer R
  ? Awaited<R>
  : H extends {
        complete: (...args: any[]) => infer R;
        failure: (...args: any[]) => infer R2;
      }
    ? Awaited<R> | Awaited<R2>
    : H extends { complete: (...args: any[]) => infer R }
      ? Awaited<R>
      : never;

// =============================================================================
// MATCH HANDLER ENTRY TYPES
// =============================================================================

/**
 * A match handler entry for a specific key.
 *
 * For BranchHandle keys (single or collection), the handler can be either a plain
 * function (failure auto-terminates workflow) or a `{ complete, failure }` object
 * for explicit failure recovery.
 *
 * For channel handles, only a plain function is allowed.
 */
export type MatchHandlerEntry<H extends SelectableHandle> = H extends
  | BranchHandle<any>
  | BranchHandle<any>[]
  | Map<any, BranchHandle<any>>
  ?
      | ((data: HandleMatchData<H>) => any)
      | {
          complete: (data: HandleMatchData<H>) => any;
          failure: (failure: BranchFailureInfo) => any;
        }
  : (data: HandleMatchData<H>) => any;

/**
 * Handler map for Selection.match().
 */
export type MatchHandlers<M extends Record<string, SelectableHandle>> = {
  [K in keyof M & string]?: MatchHandlerEntry<M[K]>;
};

/**
 * Return type of Selection.match().
 */
export type MatchReturn<
  M extends Record<string, SelectableHandle>,
  H extends MatchHandlers<M>,
> = {
  [K in keyof H & string]: ExtractHandlerReturn<H[K]>;
}[keyof H & string];

/**
 * Union of select events from keys NOT present in the handler map.
 */
export type UnhandledSelectEvent<
  M extends Record<string, SelectableHandle>,
  H extends Partial<Record<keyof M & string, any>>,
> = {
  [K in Exclude<keyof M & string, keyof H & string>]: HandleSelectEvent<
    K,
    M[K]
  >;
}[Exclude<keyof M & string, keyof H & string>];

/**
 * Unhandled select events that represent successful completion only.
 * For plain default callbacks — failures still auto-terminate.
 */
export type UnhandledSelectCompleteEvent<
  M extends Record<string, SelectableHandle>,
  H extends Partial<Record<keyof M & string, any>>,
> = Exclude<UnhandledSelectEvent<M, H>, { status: "failed" }>;

/**
 * Unhandled select events that represent branch failures.
 * For `{ complete, failure }` default callbacks.
 */
export type UnhandledSelectFailureEvent<
  M extends Record<string, SelectableHandle>,
  H extends Partial<Record<keyof M & string, any>>,
> = Extract<UnhandledSelectEvent<M, H>, { status: "failed" }>;

/**
 * Default handler entry for unhandled events in selection/forEach/map.
 *
 * - Plain function: happy path only (receives completion events only).
 * - Object form: explicit `{ complete, failure }` handling.
 */
export type DefaultUnhandledHandlerEntry<
  M extends Record<string, SelectableHandle>,
  H extends Partial<Record<keyof M & string, any>>,
> =
  | ((event: UnhandledSelectCompleteEvent<M, H>) => any)
  | {
      complete: (event: UnhandledSelectCompleteEvent<M, H>) => any;
      failure: (event: UnhandledSelectFailureEvent<M, H>) => any;
    };

// =============================================================================
// SELECTION (WorkflowContext)
// =============================================================================

/**
 * A selection — multiplexes multiple handles and yields events as they arrive.
 * Events are ordered by global_sequence for deterministic replay.
 *
 * **`for await...of`** — the primary iteration surface.
 * Yields `SelectDataUnion<M>` (successful data values) until all handles are exhausted.
 * Any branch failure auto-terminates the workflow and triggers LIFO compensation.
 * Use this for simple "process everything, fail on any error" patterns.
 *
 * **`.match()`** — the lower-level, key-aware API.
 * Waits for the first event matching a provided handler map.
 * Handlers can be plain functions (failure crashes workflow) or
 * `{ complete, failure }` objects for BranchHandle keys for explicit recovery.
 * Returns `{ ok: false, status: "exhausted" }` when all handles resolve without matching.
 *
 * For collection handles (BranchHandle[], Map<K, BranchHandle>), each element
 * produces its own event with an `innerKey`.
 *
 * @typeParam M - The handle record type.
 */
export interface Selection<
  M extends Record<string, SelectableHandle>,
> extends AsyncIterable<SelectDataUnion<M>> {
  /**
   * Wait for the first event matching a handler.
   *
   * Handlers can be plain functions (failure crashes workflow) or
   * `{ complete, failure }` objects for BranchHandle keys.
   */
  match<H extends MatchHandlers<M>>(
    handlers: H,
  ): Promise<SelectMatchResult<MatchReturn<M, H>>>;

  /** Handlers + default for unhandled events. */
  match<
    H extends MatchHandlers<M>,
    D extends DefaultUnhandledHandlerEntry<M, H>,
  >(
    handlers: H,
    defaultHandler: D,
  ): Promise<SelectMatchResult<MatchReturn<M, H> | ExtractHandlerReturn<D>>>;

  /**
   * Live set of unresolved handle keys.
   */
  readonly remaining: ReadonlySet<keyof M & string>;
}

// =============================================================================
// SELECTION (CompensationContext)
// =============================================================================

/**
 * A selection in CompensationContext.
 *
 * **`for await...of`** — yields `SelectDataUnion<M>` until all handles are exhausted.
 * Any branch failure auto-terminates the compensation scope.
 *
 * **`.match()`** — key-aware, one-event-at-a-time API with explicit `{ complete, failure }`
 * handlers for granular recovery during compensation.
 */
export interface CompensationSelection<
  M extends Record<string, SelectableHandle>,
> extends AsyncIterable<SelectDataUnion<M>> {
  /** Pattern-match on events. */
  match<H extends MatchHandlers<M>>(
    handlers: H,
  ): Promise<SelectMatchResult<MatchReturn<M, H>>>;

  /** Handlers + default. */
  match<
    H extends MatchHandlers<M>,
    D extends DefaultUnhandledHandlerEntry<M, H>,
  >(
    handlers: H,
    defaultHandler: D,
  ): Promise<SelectMatchResult<MatchReturn<M, H> | ExtractHandlerReturn<D>>>;

  /** Live set of unresolved handle keys. */
  readonly remaining: ReadonlySet<keyof M & string>;
}

// =============================================================================
// forEach / map — HANDLER ENTRY TYPES
// =============================================================================

/**
 * Extract data type from a branch handle or collection.
 * For collections, this is the element's data type (innerKey is separate).
 */
type BranchData<H> =
  H extends BranchHandle<infer T>
    ? T
    : H extends BranchHandle<infer T>[]
      ? T
      : H extends Map<any, BranchHandle<infer T>>
        ? T
        : never;

/**
 * Extract the inner key type for collection handles.
 * Single BranchHandle has no innerKey (never).
 */
type BranchInnerKey<H> =
  H extends BranchHandle<any>
    ? never
    : H extends BranchHandle<any>[]
      ? number
      : H extends Map<infer K, BranchHandle<any>>
        ? K
        : never;

/**
 * A forEach handler entry for a branch handle or collection.
 *
 * - Single `BranchHandle<T>`: plain `(data: T) => void` or `{ complete, failure }`
 * - `BranchHandle<T>[]`: receives `(data: T, innerKey: number)` per element
 * - `Map<K, BranchHandle<T>>`: receives `(data: T, innerKey: K)` per entry
 *
 * For plain function handlers, failure auto-terminates the workflow.
 * For `{ complete, failure }` handlers, failure is handled explicitly.
 */
export type ForEachHandlerEntry<H extends SelectableHandle> = H extends
  | BranchHandle<any>
  | BranchHandle<any>[]
  | Map<any, BranchHandle<any>>
  ? BranchInnerKey<H> extends never
    ? // Single BranchHandle
        | ((data: BranchData<H>) => Promise<void> | void)
        | {
            complete: (data: BranchData<H>) => Promise<void> | void;
            failure: (failure: BranchFailureInfo) => Promise<void> | void;
          }
    : // Collection BranchHandle (array or map)
        | ((
            data: BranchData<H>,
            innerKey: BranchInnerKey<H>,
          ) => Promise<void> | void)
        | {
            complete: (
              data: BranchData<H>,
              innerKey: BranchInnerKey<H>,
            ) => Promise<void> | void;
            failure: (
              failure: BranchFailureInfo,
              innerKey: BranchInnerKey<H>,
            ) => Promise<void> | void;
          }
  : never;

/**
 * A map handler entry for a branch handle or collection.
 * Same structure as ForEachHandlerEntry but returns a value instead of void.
 *
 * `ctx.map()` return type mirrors the collection structure:
 * - Single → single transformed value
 * - Array → array of transformed values
 * - Map → Map of transformed values
 */
export type MapHandlerEntry<H extends SelectableHandle> = H extends
  | BranchHandle<any>
  | BranchHandle<any>[]
  | Map<any, BranchHandle<any>>
  ? BranchInnerKey<H> extends never
    ? // Single BranchHandle
        | ((data: BranchData<H>) => any)
        | {
            complete: (data: BranchData<H>) => any;
            failure: (failure: BranchFailureInfo) => any;
          }
    : // Collection BranchHandle
        | ((data: BranchData<H>, innerKey: BranchInnerKey<H>) => any)
        | {
            complete: (data: BranchData<H>, innerKey: BranchInnerKey<H>) => any;
            failure: (
              failure: BranchFailureInfo,
              innerKey: BranchInnerKey<H>,
            ) => any;
          }
  : never;

/**
 * Mirror the map output structure to match the input collection structure.
 * - BranchHandle<T> → ExtractHandlerReturn<C>
 * - BranchHandle<T>[] → ExtractHandlerReturn<C>[]
 * - Map<K, BranchHandle<T>> → Map<K, ExtractHandlerReturn<C>>
 */
export type MapOutputFor<H, C> =
  H extends BranchHandle<any>
    ? ExtractHandlerReturn<C>
    : H extends BranchHandle<any>[]
      ? ExtractHandlerReturn<C>[]
      : H extends Map<infer K, BranchHandle<any>>
        ? Map<K, ExtractHandlerReturn<C>>
        : never;

// =============================================================================
// forEach / map — HANDLER ENTRY TYPES (CompensationContext)
// =============================================================================

/**
 * A forEach handler entry for CompensationContext.
 * Plain function — receives the branch data directly (already a result union).
 * No `complete`/`failure` split — the result union encodes success/failure.
 */
export type CompensationForEachHandlerEntry<H extends SelectableHandle> =
  H extends BranchHandle<any>
    ? (data: BranchData<H>) => Promise<void> | void
    : H extends BranchHandle<any>[]
      ? (data: BranchData<H>, innerKey: number) => Promise<void> | void
      : H extends Map<infer K, BranchHandle<any>>
        ? (data: BranchData<H>, innerKey: K) => Promise<void> | void
        : never;

/**
 * A map handler entry for CompensationContext.
 * Plain function — receives the branch data directly.
 */
export type CompensationMapHandlerEntry<H extends SelectableHandle> =
  H extends BranchHandle<any>
    ? (data: BranchData<H>) => any
    : H extends BranchHandle<any>[]
      ? (data: BranchData<H>, innerKey: number) => any
      : H extends Map<infer K, BranchHandle<any>>
        ? (data: BranchData<H>, innerKey: K) => any
        : never;
