import type { AtomicResult, BlockingResult } from "./deterministic-handles";

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
export interface ChannelReceiveCall<T> extends BlockingResult<T> {
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
   * timeout value is dynamic. Returns a `AtomicResult<T | undefined>` that
   * cannot be passed as a scope entry (it is atomic/non-blocking).
   */
  receiveNowait(): AtomicResult<T | undefined>;

  /**
   * Non-blocking poll with an explicit default.
   * Returns `defaultValue` if no message is available.
   *
   * Use this when you need to distinguish a timed-out poll from a real `undefined`
   * message value.
   */
  receiveNowait<TDefault>(defaultValue: TDefault): AtomicResult<T | TDefault>;

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
 * `write` is a buffered operation — synchronous return at the public API,
 * committed in the next batch transaction. The assigned offset is observable
 * only externally via the stream's read APIs.
 *
 * @typeParam T - The encoded record type.
 */
export interface StreamAccessor<T> {
  /**
   * Write a record to the stream.
   * @param data - Record data (z.input type — encoded).
   */
  write(data: T): void;
}

/**
 * Event accessor on ctx.events (for setting from within the workflow).
 *
 * `set` is a buffered operation — synchronous return.
 */
export interface EventAccessor {
  /**
   * Set the event (idempotent — second call is no-op).
   */
  set(): void;
}
