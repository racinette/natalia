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

export type CompensationRunner = () => PromiseLike<void>;

/**
 * Augment a failure info type with `claimCompensation()`.
 *
 * `claimCompensation()` explicitly transfers compensation ownership to user code
 * and returns the compensation callback as a callable `CompensationRunner`.
 *
 * Once claimed, the engine does NOT run this compensation automatically at scope
 * exit / LIFO unwinding anymore — user code fully owns when (or if) to execute it.
 *
 * **Context switch:** Calling the claimed runner transparently switches the
 * execution context to compensation mode (SIGTERM-resilient). The compensation
 * callback runs to completion even if SIGTERM arrives mid-execution. Control
 * returns to the `failure` handler in normal WorkflowContext after.
 *
 * Only present when a `compensate` callback was registered. If no `compensate`
 * was provided, the failure object does not include `claimCompensation` — full type safety.
 */
export type WithCompensation<T> = T & {
  readonly claimCompensation: () => CompensationRunner;
};

/**
 * Failure information for a scope branch, passed to `failure` callbacks in
 * forEach, map, and match handlers.
 *
 * Includes `claimCompensation()` to transfer compensation ownership for any
 * compensated steps registered within this branch.
 *
 * If not claimed, the engine runs branch compensations at scope exit (safe default).
 * If claimed, the engine will not take further action for that branch compensation.
 */
export interface BranchFailureInfo {
  claimCompensation(): CompensationRunner;
}

// =============================================================================
// CHANNEL HANDLE, STREAM ACCESSOR, EVENT ACCESSOR (WORKFLOW INTERNAL)
// =============================================================================

/**
 * A one-shot receive future returned by `ChannelHandle.receive(...)`.
 *
 * `ChannelReceiveCall<T>` is awaitable (extends `PromiseLike<T>`) and can be
 * passed into `ctx.select()`, `ctx.forEach()`, and `ctx.map()` as a finite,
 * one-shot channel wait — the key is removed from `remaining` once the receive
 * resolves, just like a branch handle.
 *
 * Unlike passing a raw `ChannelHandle` to `select` (which creates a streaming,
 * never-exhausted branch), a `ChannelReceiveCall` resolves exactly once.
 *
 * @typeParam T - The resolved value type (may include `undefined` for timeout overloads).
 */
export interface ChannelReceiveCall<T> extends PromiseLike<T> {
  /** @internal Brand discriminator — do not access at runtime. */
  readonly _kind: "channel_receive_call";
}

/**
 * Channel handle on ctx.channels.
 * Can be used directly for receive, passed into select, or async-iterated.
 * T is the decoded type (z.output<Schema>).
 */
export interface ChannelHandle<T> extends AsyncIterable<T> {
  /**
   * Receive a message from this channel (FIFO order).
   * Blocks until a message arrives. Returns the decoded value directly.
   *
   * Returns a `ChannelReceiveCall<T>` that can be awaited directly or passed
   * into `ctx.select()`, `ctx.forEach()`, or `ctx.map()` as a one-shot branch.
   */
  receive(): ChannelReceiveCall<T>;

  /**
   * Receive with timeout (in seconds).
   * Returns undefined when the timeout expires before a message arrives.
   *
   * `receive(0)` is a non-blocking poll (nowait).
   *
   * Returns a `ChannelReceiveCall<T | undefined>` that can be awaited directly
   * or passed into `ctx.select()`, `ctx.forEach()`, or `ctx.map()`.
   */
  receive(timeoutSeconds: number): ChannelReceiveCall<T | undefined>;

  /**
   * Receive with timeout (in seconds) and an explicit timeout default.
   * Returns `defaultValue` when the timeout expires before a message arrives.
   *
   * `receive(0, defaultValue)` is a non-blocking poll (nowait).
   *
   * Returns a `ChannelReceiveCall<T | TDefault>` that can be awaited directly
   * or passed into `ctx.select()`, `ctx.forEach()`, or `ctx.map()`.
   */
  receive<TDefault>(
    timeoutSeconds: number,
    defaultValue: TDefault,
  ): ChannelReceiveCall<T | TDefault>;

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
 * Handle types that can be passed into `ctx.select()`.
 *
 * - `BranchHandle` variants — scope branches (finite, can fail).
 * - `ChannelHandle<T>` — stream-like; the branch is **never exhausted** and
 *   delivers a new message each time it is selected. Use when you want to keep
 *   reading from a channel indefinitely (e.g. long-running consumer loops).
 *   Note: `sel.remaining` will never drop the channel key, so
 *   `while (sel.remaining.size > 0)` loops will not terminate on their own.
 * - `ChannelReceiveCall<T>` — one-shot; produced by `ctx.channels.<n>.receive(...)`.
 *   The key is removed from `remaining` once the receive resolves.
 */
export type SelectableHandle =
  | BranchHandle<any>
  | BranchHandle<any>[]
  | Map<any, BranchHandle<any>>
  | ChannelHandle<any>
  | ChannelReceiveCall<any>;

/**
 * Finite handle types — all handles that resolve exactly once and are removed
 * from `remaining` upon completion.
 *
 * Used as the accepted input type for `ctx.forEach()` and `ctx.map()`, which
 * require every branch to have a definite end. Raw `ChannelHandle` is excluded
 * because it never exhausts. Use `ctx.channels.<n>.receive(...)` to get a
 * finite one-shot `ChannelReceiveCall<T>` instead.
 */
export type FiniteHandle =
  | BranchHandle<any>
  | BranchHandle<any>[]
  | Map<any, BranchHandle<any>>
  | ChannelReceiveCall<any>;

// =============================================================================
// SELECT — EVENT TYPES (WorkflowContext)
// =============================================================================

/**
 * Map a handle type to its select event result type.
 *
 * - BranchHandle: `{ key, status: "complete", data: T } | { key, status: "failed", failure }`
 * - BranchHandle[]: `{ key, innerKey: number, status: "complete", data: T } | { key, innerKey: number, status: "failed", failure }`
 * - Map<K, BranchHandle>: `{ key, innerKey: K, status: "complete", data: T } | { key, innerKey: K, status: "failed", failure }`
 * - ChannelHandle: `{ key, data: T }` (fires repeatedly — never exhausted)
 * - ChannelReceiveCall: `{ key, data: T }` (fires once — key removed from remaining)
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
          : H extends ChannelReceiveCall<infer T>
            ? { key: K; data: T }
            : never;

/**
 * What a match handler receives for a specific key.
 *
 * - BranchHandle<T>: `T` directly
 * - BranchHandle<T>[]: `{ data: T; innerKey: number }`
 * - Map<K, BranchHandle<T>>: `{ data: T; innerKey: K }`
 * - ChannelHandle<T>: `T` directly (fires repeatedly)
 * - ChannelReceiveCall<T>: `T` directly (fires once)
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
          : H extends ChannelReceiveCall<infer T>
            ? T
            : never;

/**
 * Union of all possible events from a select record.
 */
export type SelectEvent<M extends Record<string, SelectableHandle>> = {
  [K in keyof M & string]: HandleSelectEvent<K, M[K]>;
}[keyof M & string];

/**
 * Extract the successful data type from any selectable handle.
 * Used to build `SelectDataUnion`.
 */
type SelectHandleData<H> =
  H extends BranchHandle<infer T>
    ? T
    : H extends BranchHandle<infer T>[]
      ? T
      : H extends Map<any, BranchHandle<infer T>>
        ? T
        : H extends ChannelHandle<infer T>
          ? T
          : H extends ChannelReceiveCall<infer T>
            ? T
            : never;

/**
 * Union of successful data values yielded by `for await...of` on a Selection.
 * Branch handles yield their result type T; channel handles yield their message
 * type T; one-shot receive calls yield their resolved type T.
 * For collections (array/map), the per-element data type is yielded.
 * A branch failure auto-terminates the workflow when iterating with `for await`.
 */
export type SelectDataUnion<M extends Record<string, SelectableHandle>> = {
  [K in keyof M & string]: SelectHandleData<M[K]>;
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
 * For channel handles and one-shot receive calls, only a plain function is allowed
 * (channels never fail).
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
 * Extract data type from a finite handle or collection.
 * For branch collections, this is the element's data type (innerKey is separate).
 * For ChannelReceiveCall, this is the resolved value type.
 */
type FiniteHandleData<H> =
  H extends BranchHandle<infer T>
    ? T
    : H extends BranchHandle<infer T>[]
      ? T
      : H extends Map<any, BranchHandle<infer T>>
        ? T
        : H extends ChannelReceiveCall<infer T>
          ? T
          : never;

/**
 * Extract the inner key type for collection handles.
 * Single BranchHandle and ChannelReceiveCall have no innerKey (never).
 */
type FiniteHandleInnerKey<H> =
  H extends BranchHandle<any>
    ? never
    : H extends BranchHandle<any>[]
      ? number
      : H extends Map<infer K, BranchHandle<any>>
        ? K
        : H extends ChannelReceiveCall<any>
          ? never
          : never;

/**
 * A forEach handler entry for a finite handle or collection.
 *
 * - Single `BranchHandle<T>`: plain `(data: T) => void` or `{ complete, failure }`
 * - `BranchHandle<T>[]`: receives `(data: T, innerKey: number)` per element
 * - `Map<K, BranchHandle<T>>`: receives `(data: T, innerKey: K)` per entry
 * - `ChannelReceiveCall<T>`: plain `(data: T) => void` (one-shot; no failure path)
 *
 * For plain function handlers on branch handles, failure auto-terminates the workflow.
 * For `{ complete, failure }` handlers on branch handles, failure is handled explicitly.
 * Channel receive calls never fail, so only plain function handlers are accepted.
 */
export type ForEachHandlerEntry<H extends FiniteHandle> = H extends
  | BranchHandle<any>
  | BranchHandle<any>[]
  | Map<any, BranchHandle<any>>
  ? FiniteHandleInnerKey<H> extends never
    ? // Single BranchHandle
        | ((data: FiniteHandleData<H>) => Promise<void> | void)
        | {
            complete: (data: FiniteHandleData<H>) => Promise<void> | void;
            failure: (failure: BranchFailureInfo) => Promise<void> | void;
          }
    : // Collection BranchHandle (array or map)
        | ((
            data: FiniteHandleData<H>,
            innerKey: FiniteHandleInnerKey<H>,
          ) => Promise<void> | void)
        | {
            complete: (
              data: FiniteHandleData<H>,
              innerKey: FiniteHandleInnerKey<H>,
            ) => Promise<void> | void;
            failure: (
              failure: BranchFailureInfo,
              innerKey: FiniteHandleInnerKey<H>,
            ) => Promise<void> | void;
          }
  : H extends ChannelReceiveCall<any>
    ? (data: FiniteHandleData<H>) => Promise<void> | void
    : never;

/**
 * A map handler entry for a finite handle or collection.
 * Same structure as ForEachHandlerEntry but returns a value instead of void.
 *
 * `ctx.map()` return type mirrors the collection structure:
 * - Single BranchHandle / ChannelReceiveCall → single transformed value
 * - Array → array of transformed values
 * - Map → Map of transformed values
 */
export type MapHandlerEntry<H extends FiniteHandle> = H extends
  | BranchHandle<any>
  | BranchHandle<any>[]
  | Map<any, BranchHandle<any>>
  ? FiniteHandleInnerKey<H> extends never
    ? // Single BranchHandle
        | ((data: FiniteHandleData<H>) => any)
        | {
            complete: (data: FiniteHandleData<H>) => any;
            failure: (failure: BranchFailureInfo) => any;
          }
    : // Collection BranchHandle
        | ((
            data: FiniteHandleData<H>,
            innerKey: FiniteHandleInnerKey<H>,
          ) => any)
        | {
            complete: (
              data: FiniteHandleData<H>,
              innerKey: FiniteHandleInnerKey<H>,
            ) => any;
            failure: (
              failure: BranchFailureInfo,
              innerKey: FiniteHandleInnerKey<H>,
            ) => any;
          }
  : H extends ChannelReceiveCall<any>
    ? (data: FiniteHandleData<H>) => any
    : never;

/**
 * Mirror the map output structure to match the input collection structure.
 * - BranchHandle<T> → ExtractHandlerReturn<C>
 * - BranchHandle<T>[] → ExtractHandlerReturn<C>[]
 * - Map<K, BranchHandle<T>> → Map<K, ExtractHandlerReturn<C>>
 * - ChannelReceiveCall<T> → ExtractHandlerReturn<C>
 */
export type MapOutputFor<H, C> =
  H extends BranchHandle<any>
    ? ExtractHandlerReturn<C>
    : H extends BranchHandle<any>[]
      ? ExtractHandlerReturn<C>[]
      : H extends Map<infer K, BranchHandle<any>>
        ? Map<K, ExtractHandlerReturn<C>>
        : H extends ChannelReceiveCall<any>
          ? ExtractHandlerReturn<C>
          : never;

// =============================================================================
// forEach / map — HANDLER ENTRY TYPES (CompensationContext)
// =============================================================================

/**
 * A forEach handler entry for CompensationContext.
 * Plain function — receives the branch data directly (already a result union).
 * No `complete`/`failure` split — the result union encodes success/failure.
 * Also accepts `ChannelReceiveCall<T>` for one-shot channel waits in compensation.
 */
export type CompensationForEachHandlerEntry<H extends FiniteHandle> =
  H extends BranchHandle<any>
    ? (data: FiniteHandleData<H>) => Promise<void> | void
    : H extends BranchHandle<any>[]
      ? (data: FiniteHandleData<H>, innerKey: number) => Promise<void> | void
      : H extends Map<infer K, BranchHandle<any>>
        ? (data: FiniteHandleData<H>, innerKey: K) => Promise<void> | void
        : H extends ChannelReceiveCall<any>
          ? (data: FiniteHandleData<H>) => Promise<void> | void
          : never;

/**
 * A map handler entry for CompensationContext.
 * Plain function — receives the branch data directly.
 * Also accepts `ChannelReceiveCall<T>` for one-shot channel waits in compensation.
 */
export type CompensationMapHandlerEntry<H extends FiniteHandle> =
  H extends BranchHandle<any>
    ? (data: FiniteHandleData<H>) => any
    : H extends BranchHandle<any>[]
      ? (data: FiniteHandleData<H>, innerKey: number) => any
      : H extends Map<infer K, BranchHandle<any>>
        ? (data: FiniteHandleData<H>, innerKey: K) => any
        : H extends ChannelReceiveCall<any>
          ? (data: FiniteHandleData<H>) => any
          : never;
