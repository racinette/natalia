import type { StepDefinitions } from "../definitions/steps";
import type { WorkflowDefinitions } from "../definitions/workflow-headers";
import type { ScopeFailureInfo } from "./failures";
import type { ChannelHandle, ChannelReceiveCall } from "./io-accessors";
import type { BranchEntry } from "./scope-results";
import type { IsPrefix, ScopePath } from "./scope-path";

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
  | BranchEntry<any>
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
  H extends BranchEntry<infer T, infer THandlePath>
    ? IsPrefix<THandlePath, TCurrentPath> extends true
      ? BranchEntry<T, THandlePath>
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
  H extends BranchEntry<infer T>
    ? { key: K; status: "complete"; data: T } | { key: K; status: "failed" }
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
  H extends BranchEntry<infer T>
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
  H extends BranchEntry<infer T>
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
  H extends BranchEntry<any>
    ?
        | ((data: HandleMatchData<H>) => any)
        | {
            complete: (data: HandleMatchData<H>) => any;
            failure: (
              info: ScopeFailureInfo<StepDefinitions, WorkflowDefinitions>,
            ) => any;
          }
        | { complete: (data: HandleMatchData<H>) => any }
        | {
            failure: (
              info: ScopeFailureInfo<StepDefinitions, WorkflowDefinitions>,
            ) => any;
          }
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
