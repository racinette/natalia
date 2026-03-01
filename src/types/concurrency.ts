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
 * map and match handlers.
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
 * passed into `ctx.select()` and `ctx.map()` as a finite,
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
 * into `ctx.select()` or `ctx.map()` as a one-shot branch.
   */
  receive(): ChannelReceiveCall<T>;

  /**
   * Receive with timeout (in seconds).
   * Returns undefined when the timeout expires before a message arrives.
   *
   * `receive(0)` is a non-blocking poll (nowait).
   *
   * Returns a `ChannelReceiveCall<T | undefined>` that can be awaited directly
 * or passed into `ctx.select()` or `ctx.map()`.
   */
  receive(timeoutSeconds: number): ChannelReceiveCall<T | undefined>;

  /**
   * Receive with timeout (in seconds) and an explicit timeout default.
   * Returns `defaultValue` when the timeout expires before a message arrives.
   *
   * `receive(0, defaultValue)` is a non-blocking poll (nowait).
   *
   * Returns a `ChannelReceiveCall<T | TDefault>` that can be awaited directly
 * or passed into `ctx.select()` or `ctx.map()`.
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
 * Ordered scope lineage from root to current scope.
 */
export type ScopePath = readonly string[];

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
 * - Passed into `ctx.select()` and `ctx.map()`
 * - Accumulated into collections for dynamic fan-out
 *
 * @typeParam T - The resolved value type.
 */
declare const scopePathBrand: unique symbol;

export interface BranchHandle<
  T,
  TScopePath extends ScopePath = ScopePath,
> extends Promise<T> {
  /** @internal Type-level scope ownership brand. */
  readonly [scopePathBrand]?: TScopePath;
}

/**
 * A group of branch handles — single, array, or map.
 * Used as input to `ctx.select()` and `ctx.map()`.
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
 * Append a named scope to the current lineage.
 */
export type AppendScopeName<
  TScopePath extends ScopePath,
  TName extends string,
> = [...TScopePath, TName];

/**
 * Scope name guard:
 * - literal names cannot reuse any ancestor scope name
 * - widened `string` is allowed but loses compile-time collision guarantees
 */
export type ScopeNameArg<
  TScopePath extends ScopePath,
  TName extends string,
> = string extends TName ? TName : TName extends TScopePath[number] ? never : TName;

type IsPrefix<TPrefix extends ScopePath, TValue extends ScopePath> =
  TPrefix extends []
    ? true
    : TValue extends readonly [
          infer TValueHead extends string,
          ...infer TValueTail extends ScopePath,
        ]
      ? TPrefix extends readonly [
            infer TPrefixHead extends string,
            ...infer TPrefixTail extends ScopePath,
          ]
        ? TPrefixHead extends TValueHead
          ? IsPrefix<TPrefixTail, TValueTail>
          : false
        : false
      : false;

type RestrictSelectableHandleToPath<
  H,
  TCurrentPath extends ScopePath,
> = H extends BranchHandle<infer T, infer THandlePath>
  ? IsPrefix<THandlePath, TCurrentPath> extends true
    ? BranchHandle<T, THandlePath>
    : never
  : H extends BranchHandle<infer T, infer THandlePath>[]
    ? IsPrefix<THandlePath, TCurrentPath> extends true
      ? BranchHandle<T, THandlePath>[]
      : never
    : H extends Map<infer MK, BranchHandle<infer T, infer THandlePath>>
      ? IsPrefix<THandlePath, TCurrentPath> extends true
        ? Map<MK, BranchHandle<T, THandlePath>>
        : never
      : H extends ChannelHandle<any> | ChannelReceiveCall<any>
        ? H
        : never;

type RestrictFiniteHandleToPath<
  H,
  TCurrentPath extends ScopePath,
> = H extends BranchHandle<infer T, infer THandlePath>
  ? IsPrefix<THandlePath, TCurrentPath> extends true
    ? BranchHandle<T, THandlePath>
    : never
  : H extends BranchHandle<infer T, infer THandlePath>[]
    ? IsPrefix<THandlePath, TCurrentPath> extends true
      ? BranchHandle<T, THandlePath>[]
      : never
    : H extends Map<infer MK, BranchHandle<infer T, infer THandlePath>>
      ? IsPrefix<THandlePath, TCurrentPath> extends true
        ? Map<MK, BranchHandle<T, THandlePath>>
        : never
      : H extends ChannelReceiveCall<any>
        ? H
        : never;

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
export type ScopeHandles<
  E extends ScopeEntries,
  TScopePath extends ScopePath = ScopePath,
> = {
  [K in keyof E]: E[K] extends ScopeEntryValue<any>
    ? BranchHandle<ScopeEntryResult<E[K]>, TScopePath>
    : E[K] extends (infer U)[]
      ? U extends ScopeEntryValue<any>
        ? BranchHandle<ScopeEntryResult<U>, TScopePath>[]
        : never
      : E[K] extends Map<infer MK, infer V>
        ? V extends ScopeEntryValue<any>
          ? Map<MK, BranchHandle<ScopeEntryResult<V>, TScopePath>>
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
export type ScopeSelectableHandle =
  | BranchHandle<any>
  | BranchHandle<any>[]
  | Map<any, BranchHandle<any>>
  | ChannelHandle<any>
  | ChannelReceiveCall<any>;

/**
 * Handle types that can be passed into base-context `ctx.select()`.
 *
 * Base context only supports channel-based waiting and does not allow
 * branch-handle selection (branch handles are scope-local by design).
 */
export type BaseSelectableHandle =
  | ChannelHandle<any>
  | ChannelReceiveCall<any>;

/**
 * Finite handle types — all handles that resolve exactly once and are removed
 * from `remaining` upon completion.
 *
 * Used as the accepted input type for `ctx.map()`, which
 * require every branch to have a definite end. Raw `ChannelHandle` is excluded
 * because it never exhausts. Use `ctx.channels.<n>.receive(...)` to get a
 * finite one-shot `ChannelReceiveCall<T>` instead.
 */
export type ScopeFiniteHandle =
  | BranchHandle<any>
  | BranchHandle<any>[]
  | Map<any, BranchHandle<any>>
  | ChannelReceiveCall<any>;

export type ScopeSelectableRecordForPath<
  M extends Record<string, ScopeSelectableHandle>,
  TCurrentPath extends ScopePath,
> = {
  [K in keyof M & string]: RestrictSelectableHandleToPath<M[K], TCurrentPath>;
};

export type ScopeFiniteRecordForPath<
  M extends Record<string, ScopeFiniteHandle>,
  TCurrentPath extends ScopePath,
> = {
  [K in keyof M & string]: RestrictFiniteHandleToPath<M[K], TCurrentPath>;
};

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
export type SelectEvent<M extends Record<string, ScopeSelectableHandle>> = {
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
export type SelectDataUnion<M extends Record<string, ScopeSelectableHandle>> = {
  [K in keyof M & string]: SelectHandleData<M[K]>;
}[keyof M & string];

// =============================================================================
// MATCH HELPERS
// =============================================================================

/**
 * Extract the return type from a match/map handler entry.
 *
 * - Plain function: returns the function's return type.
 * - `{ complete, failure }`: returns the union of both return types.
 * - `{ complete }` only: returns the complete return type (failure terminates).
 * - `{ failure }` only: returns TData (identity for complete) | failure return type.
 * - `undefined` or omitted: returns TData (identity — data passed through unchanged).
 *
 * TData is the raw data type for the handle — used as the identity return
 * when `complete` is not explicitly provided.
 */
type ExtractHandlerReturn<H, TData = never> =
  H extends undefined
    ? TData
    : H extends (...args: any[]) => infer R
      ? Awaited<R>
      : H extends {
            complete: (...args: any[]) => infer R;
            failure: (...args: any[]) => infer R2;
          }
        ? Awaited<R> | Awaited<R2>
        : H extends { failure: (...args: any[]) => infer R2 }
          ? TData | Awaited<R2>
          : H extends { complete: (...args: any[]) => infer R }
            ? Awaited<R>
            : TData;

/**
 * True when a handler entry has an explicit `failure` callback.
 * Used to determine whether the default failure handler applies.
 */
type HasExplicitFailure<H> =
  H extends { failure: (...args: any[]) => any } ? true : false;

// =============================================================================
// MATCH HANDLER ENTRY TYPES
// =============================================================================

/**
 * A match handler entry for a specific key.
 *
 * For BranchHandle keys (single or collection), four forms are accepted:
 * - Plain function: handles complete only; failure auto-terminates (or uses `onFailure`).
 * - `{ complete, failure }`: both paths handled explicitly.
 * - `{ complete }` only: failure auto-terminates (or uses `onFailure`).
 * - `{ failure }` only: complete yields data unchanged (identity); failure handled explicitly.
 *
 * For channel handles and one-shot receive calls, only a plain function is allowed
 * (channels never fail).
 */
export type MatchHandlerEntry<H extends ScopeSelectableHandle> = H extends
  | BranchHandle<any>
  | BranchHandle<any>[]
  | Map<any, BranchHandle<any>>
  ?
      | ((data: HandleMatchData<H>) => any)
      | {
          complete: (data: HandleMatchData<H>) => any;
          failure: (failure: BranchFailureInfo) => any;
        }
      | { complete: (data: HandleMatchData<H>) => any }
      | { failure: (failure: BranchFailureInfo) => any }
  : (data: HandleMatchData<H>) => any;

/**
 * Handler map for Selection.match().
 */
export type MatchHandlers<M extends Record<string, ScopeSelectableHandle>> = {
  [K in keyof M & string]?: MatchHandlerEntry<M[K]>;
};

/**
 * Yield type of `sel.match()` iteration.
 *
 * Iterates over ALL keys in M (not just those in H):
 * - Keys in H with an explicit `failure` handler: sealed — `DF` does not apply.
 * - Keys in H without an explicit `failure` handler: `ExtractHandlerReturn<H[K], TData> | DF`.
 * - Keys NOT in H: identity (`HandleMatchData<M[K]>`) + `DF` for failures.
 *
 * When `DF = never` (no `onFailure` argument), branch failures on unhandled paths
 * auto-terminate the workflow and contribute nothing to the yield type.
 */
export type MatchReturn<
  M extends Record<string, ScopeSelectableHandle>,
  H extends MatchHandlers<M>,
  DF = never,
> = {
  [K in keyof M & string]: K extends keyof H & string
    ? HasExplicitFailure<H[K]> extends true
      ? ExtractHandlerReturn<H[K], HandleMatchData<M[K]>>
      : ExtractHandlerReturn<H[K], HandleMatchData<M[K]>> | DF
    : HandleMatchData<M[K]> | DF;
}[keyof M & string];

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
 * **`.match(handlers, onFailure?)`** — key-aware async iteration.
 * Yields a transformed value for every event across all handles. Handlers in the
 * map override the default behavior for their key; unhandled keys yield their data
 * unchanged (identity). The iteration ends when all handles are exhausted.
 *
 * Handler forms for BranchHandle keys:
 * - Plain function: complete path only; failure auto-terminates (or uses `onFailure`).
 * - `{ complete, failure }`: both paths handled explicitly.
 * - `{ complete }` only: failure auto-terminates (or uses `onFailure`).
 * - `{ failure }` only: complete yields data unchanged; failure handled explicitly.
 *
 * The optional `onFailure` callback is the default failure handler — applied to any
 * key that does not have its own explicit `failure` handler. Its return value is
 * yielded instead of auto-terminating the workflow.
 *
 * For collection handles (BranchHandle[], Map<K, BranchHandle>), each element
 * produces its own event with an `innerKey`.
 *
 * @typeParam M - The handle record type.
 */
export interface Selection<
  M extends Record<string, ScopeSelectableHandle>,
> extends AsyncIterable<SelectDataUnion<M>> {
  /**
   * Iterate over all events with a default failure handler and no per-key transforms.
   * Equivalent to `match({}, onFailure)`: all keys yield data unchanged on complete;
   * any branch failure yields `onFailure`'s return value instead of terminating.
   *
   * Declared first so TypeScript's overload resolution correctly routes a bare
   * function argument here rather than to the `match(handlers)` overload.
   */
  match<DF extends (failure: BranchFailureInfo) => any>(
    onFailure: DF,
  ): AsyncIterable<MatchReturn<M, Record<never, never>, Awaited<ReturnType<DF>>>>;

  /**
   * Iterate over matching events.
   * Yields a transformed value for each event; unhandled keys yield data unchanged.
   * Ends when all handles are exhausted.
   */
  match<H extends MatchHandlers<M>>(
    handlers: H,
  ): AsyncIterable<MatchReturn<M, H>>;

  /**
   * Iterate over matching events with a default failure handler.
   * `onFailure` is called for branch failures on keys that have no explicit
   * `failure` handler — its return value is yielded instead of terminating.
   */
  match<H extends MatchHandlers<M>, DF extends (failure: BranchFailureInfo) => any>(
    handlers: H,
    onFailure: DF,
  ): AsyncIterable<MatchReturn<M, H, Awaited<ReturnType<DF>>>>;

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
 * **`.match(handlers, onFailure?)`** — key-aware async iteration with optional default
 * failure handler for granular recovery during compensation.
 */
export interface CompensationSelection<
  M extends Record<string, ScopeSelectableHandle>,
> extends AsyncIterable<SelectDataUnion<M>> {
  /** All keys identity, all failures caught by `onFailure`. Equivalent to `match({}, onFailure)`. */
  match<DF extends (failure: BranchFailureInfo) => any>(
    onFailure: DF,
  ): AsyncIterable<MatchReturn<M, Record<never, never>, Awaited<ReturnType<DF>>>>;

  /** Iterate over matching events; unhandled keys yield data unchanged. */
  match<H extends MatchHandlers<M>>(
    handlers: H,
  ): AsyncIterable<MatchReturn<M, H>>;

  /** Iterate with a default failure handler for keys without explicit failure handling. */
  match<H extends MatchHandlers<M>, DF extends (failure: BranchFailureInfo) => any>(
    handlers: H,
    onFailure: DF,
  ): AsyncIterable<MatchReturn<M, H, Awaited<ReturnType<DF>>>>;

  /** Live set of unresolved handle keys. */
  readonly remaining: ReadonlySet<keyof M & string>;
}

// =============================================================================
// map — HANDLER ENTRY TYPES
// =============================================================================

/**
 * Extract data type from a finite handle or collection.
 * For branch collections, this is the element's data type (innerKey is separate).
 * For ChannelReceiveCall, this is the resolved value type.
 */
export type FiniteHandleData<H> =
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
 * A map handler entry for a finite handle or collection.
 * Handles the same input shapes (single/array/map/one-shot receive) and returns a value.
 *
 * `ctx.map()` return type mirrors the collection structure:
 * - Single BranchHandle / ChannelReceiveCall → single transformed value
 * - Array → array of transformed values
 * - Map → Map of transformed values
 *
 * Handler forms for BranchHandle keys:
 * - Plain function: complete path only; failure auto-terminates.
 * - `{ complete, failure }`: both paths handled explicitly.
 * - `{ complete }` only: failure auto-terminates.
 * - `{ failure }` only: complete yields data unchanged (identity); failure handled explicitly.
 */
export type ScopeMapHandlerEntry<H extends ScopeFiniteHandle> = H extends
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
        | { complete: (data: FiniteHandleData<H>) => any }
        | { failure: (failure: BranchFailureInfo) => any }
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
        | {
            complete: (
              data: FiniteHandleData<H>,
              innerKey: FiniteHandleInnerKey<H>,
            ) => any;
          }
        | {
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
 * - BranchHandle<T> → ExtractHandlerReturn<C, T>
 * - BranchHandle<T>[] → ExtractHandlerReturn<C, T>[]
 * - Map<K, BranchHandle<T>> → Map<K, ExtractHandlerReturn<C, T>>
 * - ChannelReceiveCall<T> → ExtractHandlerReturn<C, T>
 *
 * FiniteHandleData<H> is passed as TData so that omitting `complete` in a
 * `{ failure }` handler yields the raw data unchanged (identity semantics).
 */
export type MapOutputFor<H, C> =
  H extends BranchHandle<any>
    ? ExtractHandlerReturn<C, FiniteHandleData<H>>
    : H extends BranchHandle<any>[]
      ? ExtractHandlerReturn<C, FiniteHandleData<H>>[]
      : H extends Map<infer K, BranchHandle<any>>
        ? Map<K, ExtractHandlerReturn<C, FiniteHandleData<H>>>
        : H extends ChannelReceiveCall<any>
          ? ExtractHandlerReturn<C, FiniteHandleData<H>>
          : never;

/**
 * Return type for `ctx.map()` with partial callbacks and an optional default
 * failure handler `DF`.
 *
 * For each key `K` in `M`:
 * - In `C` with explicit `failure` handler: `MapOutputFor<M[K], C[K]>` — sealed, `DF` excluded.
 * - In `C` without explicit `failure`: `MapOutputFor<M[K], C[K]> | DF` — `DF` covers failures.
 * - Not in `C`: `FiniteHandleData<M[K]> | DF` — identity for complete, `DF` for failure.
 *
 * When `DF = never` (no `onFailure` argument): `X | never = X`, failures auto-terminate.
 */
export type MapReturn<
  M extends Record<string, ScopeFiniteHandle>,
  C extends Partial<Record<keyof M & string, any>>,
  DF = never,
> = {
  [K in keyof M & string]: K extends keyof C & string
    ? HasExplicitFailure<C[K]> extends true
      ? MapOutputFor<M[K], C[K]>
      : MapOutputFor<M[K], C[K]> | DF
    : FiniteHandleData<M[K]> | DF;
};

// =============================================================================
// map — HANDLER ENTRY TYPES (CompensationContext)
// =============================================================================

/**
 * A map handler entry for CompensationContext.
 * Plain function — receives the branch data directly.
 * Also accepts `ChannelReceiveCall<T>` for one-shot channel waits in compensation.
 */
export type ScopeCompensationMapHandlerEntry<H extends ScopeFiniteHandle> =
  H extends BranchHandle<any>
    ? (data: FiniteHandleData<H>) => any
    : H extends BranchHandle<any>[]
      ? (data: FiniteHandleData<H>, innerKey: number) => any
      : H extends Map<infer K, BranchHandle<any>>
        ? (data: FiniteHandleData<H>, innerKey: K) => any
        : H extends ChannelReceiveCall<any>
          ? (data: FiniteHandleData<H>) => any
          : never;
