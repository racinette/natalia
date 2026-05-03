import type { ChannelHandle, ChannelReceiveCall } from "./io-accessors";

// =============================================================================
// LISTEN — HANDLE TYPES
// =============================================================================

/**
 * Handle types that can be passed into `ctx.listen()` (all contexts).
 *
 * Listen is channel-only. Use `ctx.match` on the workflow body / scope body
 * for entry coordination over scope handles.
 */
export type ListenableHandle = ChannelHandle<any> | ChannelReceiveCall<any>;

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
