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

// =============================================================================
// ROOT SCOPE BRANDING
// =============================================================================

declare const executionRoot: unique symbol;
declare const compensationRoot: unique symbol;

/**
 * Discriminates whether a deterministic handle was created inside a workflow
 * execution context or a compensation context.
 *
 * Handles carrying `typeof executionRoot` may only be joined from
 * `WorkflowContext` / `WorkflowConcurrencyContext`.
 * Handles carrying `typeof compensationRoot` may only be joined from
 * `CompensationContext` / `CompensationConcurrencyContext`.
 */
export type RootScope = typeof executionRoot | typeof compensationRoot;

/** @internal Used as the `TRoot` type parameter on execution-context handles. */
export type ExecutionRoot = typeof executionRoot;

/** @internal Used as the `TRoot` type parameter on compensation-context handles. */
export type CompensationRoot = typeof compensationRoot;

declare const deterministicAwaitableBrand: unique symbol;
declare const rootScopeBrand: unique symbol;
declare const phantomValueType: unique symbol;

/**
 * Opaque handle to a deterministic workflow primitive.
 *
 * Not directly awaitable — must be resolved via `ctx.execute(handle)` or `ctx.join(handle)`.
 * This intentionally excludes native Promise values from structural assignment
 * unless they are explicitly wrapped/typed by the engine as deterministic.
 *
 * @typeParam T    - The resolved value type.
 * @typeParam TRoot - Which root context created this handle
 *                   (`ExecutionRoot` or `CompensationRoot`).
 *                   Defaults to the widened `RootScope` for constraint positions.
 */
export interface DeterministicAwaitable<
  T,
  TRoot extends RootScope = RootScope,
> {
  /** @internal Brand discriminator — do not access at runtime. */
  readonly [deterministicAwaitableBrand]: true;
  /** @internal Root context discriminator — do not access at runtime. */
  readonly [rootScopeBrand]: TRoot;
  /**
   * @internal Covariant phantom field — allows TypeScript to infer `T` via
   * `H extends DeterministicAwaitable<infer T, ...>` in conditional types.
   * Optional so it never appears in required field checks.
   * Do not access at runtime.
   */
  readonly [phantomValueType]?: T;
}

declare const directAwaitableBrand: unique symbol;
declare const workflowAwaitableBrand: unique symbol;

/**
 * Directly awaitable deterministic workflow primitive.
 *
 * Represents atomic (synchronous-at-engine-level) operations such as
 * `ctx.streams.X.write()`, `ctx.events.X.set()`, `ctx.patches.X`,
 * `channels.send()`, and `receiveNowait()`.
 *
 * These operations are directly awaitable with `await` but are NOT valid
 * scope entries (they complete atomically and do not represent ongoing
 * concurrent work).
 *
 * @typeParam T - The resolved value type.
 */
export interface DirectAwaitable<T> {
  /** @internal Brand discriminator — do not access at runtime. */
  readonly [directAwaitableBrand]: true;

  then<TResult = T>(
    onfulfilled?:
      | ((value: T) => TResult | PromiseLike<TResult>)
      | null
      | undefined,
  ): DirectAwaitable<TResult>;

  /**
   * Await-compatibility signature used by TypeScript's `Awaited<T>` extraction.
   * Keep this overload broad and LAST so normal `.then(...)` calls still
   * resolve to the strongly typed generic overload above.
   */
  then(onfulfilled: (value: T, ...args: any[]) => any): any;
}

/**
 * Directly awaitable blocking workflow primitive.
 *
 * Extends `DirectAwaitable<T>` with a scope-entry brand, making it valid
 * as a `ctx.scope()` / `ctx.all()` entry in addition to being directly
 * awaitable.
 *
 * Used for blocking operations that represent ongoing concurrent work:
 * `ctx.sleep()`, `ctx.sleepUntil()`, and `ctx.channels.X.receive(...)`.
 *
 * @typeParam T - The resolved value type.
 */
export interface WorkflowAwaitable<T> extends DirectAwaitable<T> {
  /** @internal Brand discriminator — do not access at runtime. */
  readonly [workflowAwaitableBrand]: true;
}

// =============================================================================
// CHANNEL HANDLE, STREAM ACCESSOR, EVENT ACCESSOR (WORKFLOW INTERNAL)
// =============================================================================

/**
 * A one-shot receive future returned by `ChannelHandle.receive(...)`.
 *
 * Directly awaitable and can be passed into `ctx.select()` and `ctx.listen()`
 * as a finite, one-shot channel wait — the key is removed from `remaining`
 * once the receive resolves, just like a branch handle.
 *
 * Unlike passing a raw `ChannelHandle` to `listen` (which creates a streaming,
 * never-exhausted branch), a `ChannelReceiveCall` resolves exactly once.
 *
 * @typeParam T - The resolved value type (may include `undefined` or a default
 *               for timeout overloads).
 */
export interface ChannelReceiveCall<T> extends WorkflowAwaitable<T> {
  /** @internal Brand discriminator — do not access at runtime. */
  readonly _kind: "channel_receive_call";
}

/**
 * Channel handle on ctx.channels.
 * Can be used directly for receive, passed into listen, or async-iterated.
 * T is the decoded type (z.output<Schema>).
 *
 * @typeParam T - The decoded message type.
 */
export interface ChannelHandle<T> extends AsyncIterable<T> {
  /**
   * Receive a message from this channel (FIFO order).
   * Blocks until a message arrives.
   *
   * Returns a `ChannelReceiveCall<T>` that can be directly awaited or passed
   * into `ctx.select()` / `ctx.listen()` as a one-shot branch.
   */
  receive(): ChannelReceiveCall<T>;

  /**
   * Receive with timeout (in seconds).
   * Returns `undefined` when the timeout expires before a message arrives.
   *
   * Returns a `ChannelReceiveCall<T | undefined>` that can be directly awaited
   * or passed into `ctx.select()` / `ctx.listen()`.
   */
  receive(timeoutSeconds: number): ChannelReceiveCall<T | undefined>;

  /**
   * Receive with timeout (in seconds) and an explicit timeout default.
   * Returns `defaultValue` when the timeout expires before a message arrives.
   *
   * Returns a `ChannelReceiveCall<T | TDefault>` that can be directly awaited
   * or passed into `ctx.select()` / `ctx.listen()`.
   */
  receive<TDefault>(
    timeoutSeconds: number,
    defaultValue: TDefault,
  ): ChannelReceiveCall<T | TDefault>;

  /**
   * Non-blocking poll — returns immediately.
   * Returns `undefined` if no message is available.
   *
   * Use this instead of `receive(0)` to avoid return-type ambiguity when the
   * timeout value is dynamic. Returns a `DirectAwaitable<T | undefined>` that
   * cannot be passed as a scope entry (it is atomic/non-blocking).
   */
  receiveNowait(): DirectAwaitable<T | undefined>;

  /**
   * Non-blocking poll with an explicit default.
   * Returns `defaultValue` if no message is available.
   *
   * Use this when you need to distinguish a timed-out poll from a real `undefined`
   * message value.
   */
  receiveNowait<TDefault>(
    defaultValue: TDefault,
  ): DirectAwaitable<T | TDefault>;

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
 *
 * @typeParam T - The encoded record type.
 */
export interface StreamAccessor<T> {
  /**
   * Write a record to the stream.
   * @param data - Record data (z.input type — encoded).
   * @returns The offset at which the record was saved.
   */
  write(data: T): DirectAwaitable<number>;
}

/**
 * Event accessor on ctx.events (for setting from within the workflow).
 */
export interface EventAccessor {
  /**
   * Set the event (idempotent — second call is no-op).
   */
  set(): DirectAwaitable<void>;
}

// =============================================================================
// SCOPE PATH — SYMBOLS AND TYPES
// =============================================================================

declare const scopeDivider: unique symbol;
declare const branchDivider: unique symbol;

/**
 * Divider inserted into a scope path between a scope's parent path and its name.
 * Distinguishes scope name transitions from branch key transitions.
 */
export type ScopeDivider = typeof scopeDivider;

/**
 * Divider inserted into a scope path between a scope name and a branch key.
 * Distinguishes branch key transitions from scope name transitions.
 */
export type BranchDivider = typeof branchDivider;

/** Runtime-accessible scope divider value for path inspection. */
export { scopeDivider, branchDivider };

/**
 * Ordered scope lineage from root to current scope.
 * Elements are strings (scope names / branch keys) interleaved with
 * `ScopeDivider` and `BranchDivider` symbols to maintain structural
 * unambiguity at both type level and runtime.
 */
export type ScopePath = readonly (string | ScopeDivider | BranchDivider)[];

type IsPrefix<
  TPrefix extends ScopePath,
  TValue extends ScopePath,
> = TPrefix extends []
  ? true
  : TValue extends readonly [infer VH, ...infer VT extends ScopePath]
    ? TPrefix extends readonly [infer PH, ...infer PT extends ScopePath]
      ? [PH] extends [VH]
        ? [VH] extends [PH]
          ? IsPrefix<PT, VT>
          : false
        : false
      : false
    : false;

/**
 * Append a named scope to the current lineage, inserting a `scopeDivider` before the name.
 */
export type AppendScopeName<
  TScopePath extends ScopePath,
  TName extends string,
> = [...TScopePath, ScopeDivider, TName];

/**
 * Append a branch key to the current lineage, inserting a `branchDivider` before the key.
 */
export type AppendBranchKey<
  TScopePath extends ScopePath,
  TKey extends string,
> = [...TScopePath, BranchDivider, TKey];

/**
 * Scope name guard:
 * - Literal names cannot reuse any ancestor scope name (string elements only).
 * - Widened `string` is allowed but loses compile-time collision guarantees.
 *
 * **Limitation**: once a dynamic (non-literal) string is used as a scope entry
 * key, the ancestor scope path contains a wide `string` type. At that point the
 * collision check is bypassed for all nested scopes and branch closures created
 * from that entry — TypeScript cannot distinguish individual runtime keys from
 * each other at the type level. If you use dynamic keys, you are responsible for
 * ensuring scope name uniqueness manually.
 */
export type ScopeNameArg<
  TScopePath extends ScopePath,
  TName extends string,
> = string extends TName
  ? TName
  : string extends Extract<TScopePath[number], string>
    ? TName
    : TName extends Extract<TScopePath[number], string>
      ? never
      : TName;

/**
 * Rest-parameter constraint for `ctx.join()` scope-path enforcement.
 *
 * - For a plain `DeterministicAwaitable` (no scope path), resolves to `[]` — no path check needed.
 * - For a `BranchHandle<T, THandlePath>`, resolves to `[]` when `THandlePath` is a prefix
 *   of the current scope path `TCurrentPath`, or to an error tuple otherwise.
 */
export type IsJoinableByPath<H, TCurrentPath extends ScopePath> =
  H extends BranchHandle<any, infer THandlePath, any>
    ? IsPrefix<THandlePath, TCurrentPath> extends true
      ? []
      : [
          "Handle scope path is not accessible from the current scope — the handle was created in a scope that has already closed or is not an ancestor of the current scope",
        ]
    : [];

// =============================================================================
// SCOPE TYPES — ENTRY, BRANCH HANDLES
// =============================================================================

/**
 * A scope entry — an async closure that receives a path-specialized base context
 * and runs on the virtual event loop.
 *
 * `Tctx` is instantiated by `context.ts` with the path-specialized
 * `WorkflowContext<..., AppendBranchKey<AppendScopeName<TScopePath, Name>, K>>`
 * or the compensation equivalent, so branch identity stays precise.
 *
 * @typeParam Tctx - The path-specialized context for this branch.
 * @typeParam T          - The resolved value type of the branch.
 */
export type ScopeEntry<Tctx, T = unknown> = (ctx: Tctx) => Promise<T>;

/**
 * A handle to a running scope branch.
 * Resolves to T when the branch completes successfully.
 *
 * `BranchHandle<T>` values are produced by `ctx.scope()` and can be:
 * - Resolved via `ctx.execute(handle)` on base contexts or `ctx.join(handle)` on concurrency contexts
 * - Passed into `ctx.select()` and `ctx.match()`
 *
 * @typeParam T          - The resolved value type.
 * @typeParam TScopePath - Scope lineage of the parent scope that spawned this branch.
 *                        `ctx.join()` enforces `IsPrefix<TScopePath, TCurrentPath>`.
 * @typeParam TRoot      - Root context that created this branch handle.
 */
declare const scopePathBrand: unique symbol;

export interface BranchHandle<
  T,
  TScopePath extends ScopePath = ScopePath,
  TRoot extends RootScope = RootScope,
> extends DeterministicAwaitable<T, TRoot> {
  /** @internal Type-level scope ownership brand. */
  readonly [scopePathBrand]: TScopePath;
}

/**
 * Maps closure entries to their corresponding branch handle types.
 *
 * @typeParam E          - Record of branch closures `(ctx: any) => Promise<unknown>`.
 * @typeParam TScopePath - The scope path where these handles are created.
 * @typeParam TRoot      - The root context.
 */
export type ScopeHandles<
  E extends Record<string, (ctx: any) => Promise<unknown>>,
  TScopePath extends ScopePath,
  TRoot extends RootScope,
> = {
  [K in keyof E]: BranchHandle<Awaited<ReturnType<E[K]>>, TScopePath, TRoot>;
};

/**
 * Result type for `ctx.first()` — a discriminated union of `{ key, result }` pairs
 * for the first branch to complete.
 *
 * @typeParam E - Record of branch closures.
 */
export type FirstResult<
  E extends Record<string, (ctx: any) => Promise<unknown>>,
> = {
  [K in keyof E]: { key: K; result: Awaited<ReturnType<E[K]>> };
}[keyof E];

// =============================================================================
// SELECT / LISTEN — HANDLE TYPES
// =============================================================================

/**
 * Handle types that can be passed into `ctx.select()` (concurrency contexts only).
 *
 * - `BranchHandle<T>` — scope branches (finite, can fail).
 * - `ChannelHandle<T>` — stream-like; the branch is **never exhausted** and
 *   delivers a new message each time it is selected. Use when you want to keep
 *   reading from a channel indefinitely (e.g. long-running consumer loops).
 *   Note: `sel.remaining` will never drop the channel key.
 * - `ChannelReceiveCall<T>` — one-shot; produced by `ctx.channels.<n>.receive(...)`.
 *   The key is removed from `remaining` once the receive resolves.
 */
export type ScopeSelectableHandle =
  | BranchHandle<any>
  | ChannelHandle<any>
  | ChannelReceiveCall<any>;

/**
 * Handle types that can be passed into `ctx.listen()` (all contexts).
 *
 * Listen is channel-only — branch handles are not allowed.
 * Use `ctx.select()` on concurrency contexts for branch handle coordination.
 */
export type ListenableHandle = ChannelHandle<any> | ChannelReceiveCall<any>;

export type ScopeSelectableRecordForPath<
  M extends Record<string, ScopeSelectableHandle>,
  TCurrentPath extends ScopePath,
> = {
  [K in keyof M & string]: RestrictSelectableHandleToPath<M[K], TCurrentPath>;
};

type RestrictSelectableHandleToPath<H, TCurrentPath extends ScopePath> =
  H extends BranchHandle<infer T, infer THandlePath>
    ? IsPrefix<THandlePath, TCurrentPath> extends true
      ? BranchHandle<T, THandlePath>
      : never
    : H extends ChannelHandle<any> | ChannelReceiveCall<any>
      ? H
      : never;

// =============================================================================
// SELECT — EVENT TYPES (WorkflowContext)
// =============================================================================

/**
 * Map a handle type to its select event result type.
 *
 * - BranchHandle: `{ key, status: "complete", data: T } | { key, status: "failed", failure }`
 * - ChannelHandle: `{ key, data: T }` (fires repeatedly — never exhausted)
 * - ChannelReceiveCall: `{ key, data: T }` (fires once — key removed from remaining)
 */
export type HandleSelectEvent<K extends string, H> =
  H extends BranchHandle<infer T>
    ?
        | { key: K; status: "complete"; data: T }
        | { key: K; status: "failed" }
    : H extends ChannelHandle<infer T>
      ? { key: K; data: T }
      : H extends ChannelReceiveCall<infer T>
        ? { key: K; data: T }
        : never;

/**
 * What a match handler receives for a specific key.
 *
 * - BranchHandle<T>: `T` directly
 * - ChannelHandle<T>: `T` directly (fires repeatedly)
 * - ChannelReceiveCall<T>: `T` directly (fires once)
 */
export type HandleMatchData<H> =
  H extends BranchHandle<infer T>
    ? T
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
 */
type SelectHandleData<H> =
  H extends BranchHandle<infer T>
    ? T
    : H extends ChannelHandle<infer T>
      ? T
      : H extends ChannelReceiveCall<infer T>
        ? T
        : never;

/**
 * Keyed union type yielded by `ctx.match(sel)` (no-handler form).
 * Each element is `{ key: K; result: SelectHandleData<M[K]> }`.
 */
export type SelectDataKeyedUnion<
  M extends Record<string, ScopeSelectableHandle>,
> = {
  [K in keyof M & string]: { key: K; result: SelectHandleData<M[K]> };
}[keyof M & string];

// =============================================================================
// MATCH HELPERS
// =============================================================================

/**
 * Extract the return type from a match handler entry.
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
type ExtractHandlerReturn<H, TData = never> = H extends undefined
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
type HasExplicitFailure<H> = H extends { failure: (...args: any[]) => any }
  ? true
  : false;

// =============================================================================
// MATCH HANDLER ENTRY TYPES
// =============================================================================

/**
 * A match handler entry for a specific key.
 *
 * For BranchHandle keys, four forms are accepted:
 * - Plain function: handles complete only; failure auto-terminates (or uses `onFailure`).
 * - `{ complete, failure }`: both paths handled explicitly.
 * - `{ complete }` only: failure auto-terminates (or uses `onFailure`).
 * - `{ failure }` only: complete yields data unchanged (identity); failure handled explicitly.
 *
 * For channel handles and one-shot receive calls, only a plain function is allowed
 * (channels never fail).
 */
export type MatchHandlerEntry<H extends ScopeSelectableHandle> =
  H extends BranchHandle<any>
    ?
        | ((data: HandleMatchData<H>) => any)
        | {
            complete: (data: HandleMatchData<H>) => any;
            failure: () => any;
          }
        | { complete: (data: HandleMatchData<H>) => any }
        | { failure: () => any }
    : (data: HandleMatchData<H>) => any;

/**
 * Handler map for `ctx.match()`.
 */
export type MatchHandlers<M extends Record<string, ScopeSelectableHandle>> = {
  [K in keyof M & string]?: MatchHandlerEntry<M[K]>;
};

/**
 * Yield type of `ctx.match()` iteration.
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
// SELECTION (WorkflowConcurrencyContext)
// =============================================================================

/**
 * A selection — multiplexes multiple handles and yields events as they arrive.
 * Events are ordered by global_sequence for deterministic replay.
 *
 * Iterate over events using `ctx.match(sel, ...)` on the concurrency context.
 * `sel.remaining` tracks which handles are still active.
 *
 * @typeParam M - The handle record type.
 */
export interface Selection<M extends Record<string, ScopeSelectableHandle>> {
  /**
   * Live set of unresolved handle keys.
   */
  readonly remaining: ReadonlySet<keyof M & string>;
}

// =============================================================================
// SELECTION (CompensationConcurrencyContext)
// =============================================================================

/**
 * A selection in CompensationConcurrencyContext.
 *
 * Iterate over events using `ctx.match(sel, ...)` on the compensation concurrency context.
 * `sel.remaining` tracks which handles are still active.
 */
export interface CompensationSelection<
  M extends Record<string, ScopeSelectableHandle>,
> {
  /**
   * Live set of unresolved handle keys.
   */
  readonly remaining: ReadonlySet<keyof M & string>;
}

// =============================================================================
// LISTENER — for ctx.listen() (all contexts)
// =============================================================================

/**
 * Event type yielded by a `Listener<M>` on each iteration.
 * Each event is `{ key: K; message: T }` where T is the channel's message type.
 */
export type ListenerEvent<M extends Record<string, ListenableHandle>> = {
  [K in keyof M & string]: {
    key: K;
    message: M[K] extends ChannelHandle<infer T>
      ? T
      : M[K] extends ChannelReceiveCall<infer T>
        ? T
        : never;
  };
}[keyof M & string];

/**
 * A listener — channel-only multiplexed iteration handle returned by `ctx.listen()`.
 *
 * Directly iterable via `for await (const { key, message } of listener) { ... }`.
 * `listener.remaining` tracks which one-shot receives are still pending
 * (raw `ChannelHandle` keys are never removed).
 *
 * @typeParam M - Record of `ListenableHandle` values.
 */
export interface Listener<
  M extends Record<string, ListenableHandle>,
> extends AsyncIterable<ListenerEvent<M>> {
  readonly remaining: ReadonlySet<keyof M & string>;
}
