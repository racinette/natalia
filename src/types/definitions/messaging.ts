import type { JsonSchemaConstraint } from "../json-input";
import type { ErrorDefinitions } from "./errors";
import type {
  QueueHandlerRetryPolicy,
  QueueRetentionPolicy,
} from "./handlers";

/**
 * Scheduled delivery options for workflow starts (not queue enqueue).
 *
 * `delaySeconds` and `scheduledAt` are mutually exclusive.
 */
export type ScheduledDeliveryOptions =
  | { readonly delaySeconds: number; readonly scheduledAt?: never }
  | { readonly scheduledAt: Date; readonly delaySeconds?: never }
  | { readonly delaySeconds?: undefined; readonly scheduledAt?: undefined };

/**
 * Workflow-side queue enqueue options (buffered; no operator session).
 *
 * `delay`: omit or `0` = immediate; `number` = commit-relative seconds;
 * `Date` = absolute eligible time.
 *
 * `ttl`: omit = use the queue definition's `defaultTtl` (required on enqueue
 * when the definition has no default); `null` = never expires; `number` =
 * wall-clock seconds from commit; `Date` = absolute expiry.
 */
export type QueueEnqueueOptions = {
  readonly priority?: number;
  readonly delay?: number | Date | 0;
  readonly ttl?: number | Date | null;
};

/**
 * Enqueue options when the queue definition does not declare `defaultTtl`.
 */
export type QueueEnqueueOptionsWithRequiredTtl = QueueEnqueueOptions & {
  readonly ttl: number | Date | null;
};

/**
 * Client-side queue handler registration options (runtime-owned IO).
 */
export interface QueueHandlerRegistrationOptions<
  TErrors extends ErrorDefinitions = Record<string, never>,
  TMessage = unknown,
> {
  readonly retryPolicy: QueueHandlerRetryPolicy;
  readonly maxConcurrent?: number;
  readonly retentionPolicy?: QueueRetentionPolicy<TErrors, TMessage>;
}

/**
 * Queue definition — created via `defineQueue()`.
 *
 * Data-only: handlers register on `client.queues.<definitionName>`.
 */
export interface QueueDefinition<
  TName extends string = string,
  TMessageSchema extends JsonSchemaConstraint = JsonSchemaConstraint,
  TErrors extends ErrorDefinitions = Record<string, never>,
  TDefaultTtl extends number | Date | null | undefined = undefined,
> {
  readonly name: TName;
  /** Message schema for enqueued payloads and decoded handler messages. */
  readonly message: TMessageSchema;
  /** Optional declared handler error codes (`true` or schema per code). */
  readonly errors?: TErrors;
  /** Default enqueue delay. Omit = `0` (immediate). */
  readonly defaultDelay?: number | Date | 0;
  /** Default message TTL. Omit at definition time = enqueue must pass `ttl`. */
  readonly defaultTtl?: TDefaultTtl;
}

/**
 * Map of queue definitions.
 */
export type QueueDefinitions = Record<
  string,
  QueueDefinition<
    string,
    JsonSchemaConstraint,
    ErrorDefinitions,
    number | Date | null | undefined
  >
>;

/**
 * Topic definition — created via `defineTopic()`.
 *
 * Data-only: consumer registration will live on the client (not implemented yet).
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
}

/**
 * Map of topic definitions.
 */
export type TopicDefinitions = Record<
  string,
  TopicDefinition<string, JsonSchemaConstraint, JsonSchemaConstraint | undefined>
>;
