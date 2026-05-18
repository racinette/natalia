import type { StandardSchemaV1 } from "../standard-schema";
import type { JsonSchemaConstraint } from "../json-input";
import type {
  HandlerRetryOptions,
  QueueHandlerContext,
  QueueHandlerResult,
  TopicConsumerContext,
  Unsubscribe,
} from "./handlers";

/**
 * Scheduled delivery options for queue enqueue and workflow starts.
 *
 * `delaySeconds` and `scheduledAt` are mutually exclusive.
 */
export type ScheduledDeliveryOptions =
  | { readonly delaySeconds: number; readonly scheduledAt?: never }
  | { readonly scheduledAt: Date; readonly delaySeconds?: never }
  | { readonly delaySeconds?: undefined; readonly scheduledAt?: undefined };

/**
 * Workflow-side queue enqueue options (buffered; no `txOrConn`).
 */
export type QueueEnqueueOptions = ScheduledDeliveryOptions & {
  readonly priority?: number;
  readonly ttlSeconds?: number;
};

/**
 * Client-side queue handler registration options (runtime-owned IO).
 */
export interface QueueHandlerRegistrationOptions {
  readonly retryPolicy?: HandlerRetryOptions;
  readonly maxConcurrent?: number;
}

/**
 * Queue definition — created via `defineQueue()`.
 *
 * `registerHandler` is still attached for early API shaping; `REFACTOR.MD`
 * moves durable registration to the engine/client. The authoring helper wires a
 * stub that returns a no-op unsubscribe until that lands.
 */
export interface QueueDefinition<
  TName extends string = string,
  TMessageSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
> {
  readonly name: TName;
  /** Message schema for enqueued payloads and decoded handler messages. */
  readonly message: TMessageSchema;
  readonly ttlSeconds?: number;
  registerHandler(
    handler: (
      message: StandardSchemaV1.InferOutput<TMessageSchema>,
      opts: QueueHandlerContext,
    ) => Promise<QueueHandlerResult>,
    options?: {
      readonly retryPolicy?: HandlerRetryOptions;
      readonly maxConcurrent?: number;
    },
  ): Unsubscribe;
}

/**
 * Map of queue definitions.
 */
export type QueueDefinitions = Record<
  string,
  QueueDefinition<string, JsonSchemaConstraint>
>;

/**
 * Topic definition — created via `defineTopic()`.
 *
 * `registerConsumer` follows the same transitional pattern as queue handlers
 * (see `QueueDefinition`); the definition-level hook is a stub for now.
 */
export interface TopicDefinition<
  TName extends string = string,
  TRecordSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TMetadataSchema extends JsonSchemaConstraint | undefined = undefined,
> {
  readonly name: TName;
  /** Record schema for published payloads and decoded consumer records. */
  readonly record: TRecordSchema;
  /** Optional metadata schema attached to published records. */
  readonly metadata?: TMetadataSchema;
  readonly retentionSeconds?: number;
  registerConsumer(
    name: string,
    handler: (
      record: StandardSchemaV1.InferOutput<TRecordSchema>,
      opts: TopicConsumerContext,
    ) => Promise<void>,
    options?: {
      readonly retryPolicy?: HandlerRetryOptions;
      readonly neverExpire?: boolean;
    },
  ): Unsubscribe;
}

/**
 * Map of topic definitions.
 */
export type TopicDefinitions = Record<
  string,
  TopicDefinition<string, JsonSchemaConstraint, JsonSchemaConstraint | undefined>
>;
