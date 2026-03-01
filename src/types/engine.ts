import type { StandardSchemaV1 } from "./standard-schema";
import type {
  ChannelDefinitions,
  StreamDefinitions,
  EventDefinitions,
  RetentionSettings,
  WorkflowInvocationBaseOptions,
  DeadlineOptions,
} from "./definitions";
import type {
  ChannelSendResult,
  StreamReadResult,
  StreamIteratorReadResult,
  StreamOpenResult,
  EventWaitResult,
  EventCheckResult,
  SignalResult,
  WorkflowResultExternal,
  ExternalWaitOptions,
} from "./results";

// =============================================================================
// ENGINE LEVEL — EXTERNAL HANDLES
// =============================================================================

/**
 * Channel accessor at engine level.
 * T is z.input<Schema> for sending (encoded).
 */
export interface ChannelAccessorExternal<T> {
  /**
   * Send a message to this channel.
   * @param data - Message data (z.input type — encoded).
   * @returns Result indicating success or workflow not found.
   */
  send(data: T): Promise<ChannelSendResult>;
}

/**
 * Event accessor at engine level (with "never" support).
 */
export interface EventAccessorExternal {
  /**
   * Wait for the event to be set.
   * Returns "never" if the workflow finished without setting this event.
   */
  wait(options?: ExternalWaitOptions): Promise<EventWaitResult>;

  /**
   * Check if the event is set (non-blocking).
   */
  isSet(): Promise<EventCheckResult>;
}

/**
 * Lifecycle event accessor at engine level.
 * Uses AbortSignal for runtime wait cancellation.
 */
export interface LifecycleEventAccessorExternal {
  /**
   * Wait for the lifecycle event to be set.
   * Returns "never" if the workflow reached a terminal state without this event firing.
   */
  wait(options?: ExternalWaitOptions): Promise<EventWaitResult>;

  /**
   * Check if the lifecycle event is set (non-blocking).
   */
  get(): Promise<EventCheckResult>;
}

/**
 * All lifecycle events available on an external workflow handle.
 */
export interface LifecycleEventsExternal {
  readonly started: LifecycleEventAccessorExternal;
  readonly sigterm: LifecycleEventAccessorExternal;
  readonly compensating: LifecycleEventAccessorExternal;
  readonly compensated: LifecycleEventAccessorExternal;
  readonly complete: LifecycleEventAccessorExternal;
  readonly failed: LifecycleEventAccessorExternal;
}

/**
 * Stream iterator handle at engine level.
 * Uses AbortSignal for runtime wait cancellation.
 * T is the decoded type (z.output<Schema>).
 */
export interface StreamIteratorHandleExternal<T> extends AsyncIterable<T> {
  /**
   * Read the next record from the stream.
   * @param options - Optional wait options with AbortSignal.
   */
  read(options?: ExternalWaitOptions): Promise<StreamIteratorReadResult<T>>;

  /**
   * Iterate stream records sequentially.
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<T>;
}

/**
 * Stream reader at engine level.
 * Uses AbortSignal for runtime wait cancellation.
 * T is the decoded type (z.output<Schema>).
 */
export interface StreamReaderAccessorExternal<T> extends AsyncIterable<T> {
  /**
   * Read a record at the given offset (random access).
   * @param offset - The stream offset to read from.
   * @param options - Optional wait options with AbortSignal.
   */
  read(
    offset: number,
    options?: ExternalWaitOptions,
  ): Promise<StreamReadResult<T>>;

  /**
   * Create an iterator starting at the given offset.
   * @param startOffset - Start reading from this offset (default: 0).
   * @param endOffset - Stop reading at this offset (inclusive, default: unbounded).
   */
  iterator(
    startOffset?: number,
    endOffset?: number,
  ): StreamIteratorHandleExternal<T>;

  /**
   * Check if the stream is still open.
   */
  isOpen(): Promise<StreamOpenResult>;

  /**
   * Iterate stream records from offset 0.
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<T>;
}

/**
 * Handle to a workflow from engine level.
 * Full access to all public APIs: channels, streams, events, lifecycle, signals.
 *
 * Engine-level handles retain `sigterm()` and `sigkill()` — these are
 * operational concerns for engine callers. Workflow code uses scopes instead.
 */
export interface WorkflowHandleExternal<
  TResult,
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
> {
  readonly id: string;

  /**
   * Channels for sending messages.
   * Send accepts z.input<Schema> (encoded).
   */
  readonly channels: {
    [K in keyof TChannels]: ChannelAccessorExternal<
      StandardSchemaV1.InferInput<TChannels[K]>
    >;
  };

  /**
   * Streams for reading data.
   * Read returns z.output<Schema> (decoded).
   */
  readonly streams: {
    [K in keyof TStreams]: StreamReaderAccessorExternal<
      StandardSchemaV1.InferOutput<TStreams[K]>
    >;
  };

  /**
   * User-defined events.
   */
  readonly events: {
    [K in keyof TEvents]: EventAccessorExternal;
  };

  /**
   * Engine-managed lifecycle events.
   */
  readonly lifecycle: LifecycleEventsExternal;

  /**
   * Wait for workflow to complete and get result.
   */
  getResult(
    options?: ExternalWaitOptions,
  ): Promise<WorkflowResultExternal<TResult>>;

  /**
   * Send SIGTERM — graceful shutdown with compensation.
   */
  sigterm(): Promise<SignalResult>;

  /**
   * Send SIGKILL — immediate shutdown without compensation or hooks.
   */
  sigkill(): Promise<SignalResult>;

  /**
   * Update the retention policy for this workflow instance.
   */
  setRetention(retention: number | Partial<RetentionSettings>): Promise<void>;
}

// =============================================================================
// START WORKFLOW OPTIONS (ENGINE LEVEL)
// =============================================================================

/**
 * Options for starting a workflow at engine level.
 */
export type StartWorkflowOptions<
  TArgsInput,
  TMetadataInput = void,
> = WorkflowInvocationBaseOptions<TArgsInput, TMetadataInput> & {
  /**
   * Override retention policy for this workflow instance.
   */
  retention?: number | RetentionSettings;
} & DeadlineOptions;
