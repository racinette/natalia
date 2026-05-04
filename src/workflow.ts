import type { StandardSchemaV1 } from "./types/standard-schema";
import type {
  StepDefinition,
  StepCompensationDefinition,
  NonCompensableStepDefinitions,
  RequestDefinition,
  RequestCompensationConfig,
  RequestCompensationDefinition,
  RequestCompensationHandlerOptions,
  RequestCompensationInfo,
  NonCompensableRequestDefinitions,
  QueueDefinition,
  QueueDefinitions,
  TopicDefinition,
  TopicDefinitions,
  RetryPolicyOptions,
  AttributeDefinitions,
  ChannelDefinitions,
  StreamDefinitions,
  EventDefinitions,
  StepDefinitions,
  RequestDefinitions,
  WorkflowDefinitions,
  WorkflowDefinition,
  WorkflowHeader,
  JsonSchemaConstraint,
  JsonObjectSchemaConstraint,
  WorkflowContext,
  CompensationContext,
  PatchDefinitions,
  RngDefinitions,
  WorkflowErrorDefinitions,
  Unsubscribe,
} from "./types";

export { AttemptError } from "./types/results";

function isStandardSchema(value: unknown): value is JsonSchemaConstraint {
  return (
    !!value &&
    typeof value === "object" &&
    "~standard" in value
  );
}

function validateErrorDefinitions(
  errors: unknown,
  label: string,
): asserts errors is Record<string, JsonSchemaConstraint | true> {
  if (typeof errors !== "object" || errors === null || Array.isArray(errors)) {
    throw new Error(`${label} must be an object`);
  }
  for (const [name, definition] of Object.entries(errors)) {
    if (definition !== true && !isStandardSchema(definition)) {
      throw new Error(
        `${label.slice(0, -1)} '${name}' must be true or a standard schema`,
      );
    }
  }
}

const noopUnsubscribe = (): void => undefined;

export const MANUAL: unique symbol = Symbol("MANUAL") as any;

type RequestCompensationHandlerResult<TCompensation> =
  TCompensation extends { readonly result?: infer TResultSchema }
    ? TResultSchema extends JsonSchemaConstraint
      ? StandardSchemaV1.InferInput<TResultSchema>
      : void
    : void;

// =============================================================================
// DEFINE STEP
// =============================================================================

/**
 * Define a reusable step.
 *
 * Steps are durable, idempotent operations that:
 * - Are automatically retried on failure per their retry policy
 * - Have their results cached for deterministic replay
 *
 * In `WorkflowContext`, calling a step returns a `StepCall<T>` thenable.
 * Await it directly for the happy path (failure auto-terminates the workflow),
 * or chain builder methods before awaiting:
 * - `.compensate(cb)` — register compensation callback
 * - `.retry(policy)` — override retry policy
 * - `.failure(cb)` — handle failure explicitly without auto-terminating
 * - `.complete(cb)` — transform success result
 *
 * In `CompensationContext`, calling a step returns a `CompensationStepCall<T>`
 * thenable that resolves to `CompensationStepResult<T>` — a discriminated union
 * that compensation code must handle gracefully.
 *
 * LOGGING: Use your own application logger (console.log, Winston, Pino, etc.)
 * inside step implementations. Workflow-level logging is separate via ctx.logger.
 *
 * @example
 * ```typescript
 * const FlightBookingResult = z.object({
 *   id: z.string(),
 *   price: z.number(),
 * });
 *
 * const bookFlight = defineStep({
 *   name: 'bookFlight',
 *   args: z.object({ destination: z.string(), customerId: z.string() }),
 *   result: FlightBookingResult,
 *   execute: async ({ signal }, args) => {
 *     const res = await fetch('https://api.flights.com/book', {
 *       method: 'POST',
 *       body: JSON.stringify(args),
 *       signal,
 *     });
 *     return res.json();
 *   },
 *   retryPolicy: { maxAttempts: 3, intervalSeconds: 2 },
 * });
 *
 * const cancelFlight = defineStep({
 *   name: 'cancelFlight',
 *   args: z.object({ destination: z.string(), customerId: z.string() }),
 *   result: z.object({ ok: z.boolean() }),
 *   execute: async ({ signal }, args) => {
 *     await fetch('https://api.flights.com/cancel-by-route', {
 *       method: 'POST',
 *       body: JSON.stringify(args),
 *       signal,
 *     });
 *     return { ok: true };
 *   },
 *   retryPolicy: { maxAttempts: 20, intervalSeconds: 5 },
 * });
 * ```
 */
export function defineStep<
  TName extends string,
  TArgsSchema extends JsonSchemaConstraint,
  TResultSchema extends JsonSchemaConstraint,
  TCompChannels extends ChannelDefinitions = Record<string, never>,
  TCompStreams extends StreamDefinitions = Record<string, never>,
  TCompEvents extends EventDefinitions = Record<string, never>,
  TCompAttributes extends AttributeDefinitions = Record<string, never>,
  TCompensationSteps extends NonCompensableStepDefinitions = Record<string, never>,
  TCompensationRequests extends NonCompensableRequestDefinitions = Record<string, never>,
  TCompQueues extends QueueDefinitions = Record<string, never>,
  TCompTopics extends TopicDefinitions = Record<string, never>,
  TCompChildWorkflows extends WorkflowDefinitions = Record<string, never>,
  TCompensationResultSchema extends JsonSchemaConstraint | undefined = undefined,
>(config: {
  name: TName;
  args: TArgsSchema;
  result: TResultSchema;
  compensation: StepCompensationDefinition<
    TArgsSchema,
    TResultSchema,
    TCompChannels,
    TCompStreams,
    TCompEvents,
    TCompAttributes,
    TCompensationSteps,
    TCompensationRequests,
    TCompQueues,
    TCompTopics,
    TCompChildWorkflows,
    TCompensationResultSchema
  >;
  execute: (
    context: { signal: AbortSignal },
    args: StandardSchemaV1.InferOutput<TArgsSchema>,
  ) => Promise<StandardSchemaV1.InferInput<TResultSchema>>;
  retryPolicy?: RetryPolicyOptions;
}): StepDefinition<
  TName,
  TArgsSchema,
  TResultSchema,
  StepCompensationDefinition<
    TArgsSchema,
    TResultSchema,
    TCompChannels,
    TCompStreams,
    TCompEvents,
    TCompAttributes,
    TCompensationSteps,
    TCompensationRequests,
    TCompQueues,
    TCompTopics,
    TCompChildWorkflows,
    TCompensationResultSchema
  >
>;
export function defineStep<
  TName extends string,
  TArgsSchema extends JsonSchemaConstraint,
  TResultSchema extends JsonSchemaConstraint,
>(config: {
  name: TName;
  args: TArgsSchema;
  result: TResultSchema;
  compensation?: undefined;
  execute: (
    context: { signal: AbortSignal },
    args: StandardSchemaV1.InferOutput<TArgsSchema>,
  ) => Promise<StandardSchemaV1.InferInput<TResultSchema>>;
  retryPolicy?: RetryPolicyOptions;
}): StepDefinition<TName, TArgsSchema, TResultSchema>;
export function defineStep(config: {
  name: string;
  args: JsonSchemaConstraint;
  result: JsonSchemaConstraint;
  compensation?: StepCompensationDefinition<
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any
  >;
  execute: (context: { signal: AbortSignal }, args: unknown) => Promise<unknown>;
  retryPolicy?: RetryPolicyOptions;
}): StepDefinition<any, any, any, any> {
  if (!config.name || typeof config.name !== "string") {
    throw new Error("Step name must be a non-empty string");
  }
  if (typeof config.execute !== "function") {
    throw new Error("Step execute must be a function");
  }
  if (!config.result || !("~standard" in config.result)) {
    throw new Error("Step result must be a standard schema");
  }
  if (!config.args || !("~standard" in config.args)) {
    throw new Error("Step args must be a standard schema");
  }
  if (config.compensation !== undefined) {
    if (
      typeof config.compensation !== "object" ||
      config.compensation === null ||
      Array.isArray(config.compensation)
    ) {
      throw new Error("Step compensation must be an object");
    }
    if (typeof config.compensation.undo !== "function") {
      throw new Error("Step compensation undo must be a function");
    }
    if (
      config.compensation.result !== undefined &&
      !isStandardSchema(config.compensation.result)
    ) {
      throw new Error("Step compensation result must be a standard schema");
    }
  }

  return {
    name: config.name,
    execute: config.execute,
    args: config.args,
    result: config.result,
    retryPolicy: config.retryPolicy,
    compensation: config.compensation,
  } as StepDefinition<any, any, any, any>;
}

// =============================================================================
// DEFINE REQUEST
// =============================================================================

/**
 * Define a typed request-response interaction.
 */
export function defineRequest<
  TName extends string,
  TPayloadSchema extends JsonSchemaConstraint,
  TResponseSchema extends JsonSchemaConstraint,
  TCompensationResultSchema extends JsonSchemaConstraint | undefined = undefined,
>(config: {
  name: TName;
  payload: TPayloadSchema;
  response: TResponseSchema;
  compensation: RequestCompensationConfig<TCompensationResultSchema>;
}): RequestDefinition<
  TName,
  TPayloadSchema,
  TResponseSchema,
  RequestCompensationConfig<TCompensationResultSchema>
>;
export function defineRequest<
  TName extends string,
  TPayloadSchema extends JsonSchemaConstraint,
  TResponseSchema extends JsonSchemaConstraint,
>(config: {
  name: TName;
  payload: TPayloadSchema;
  response: TResponseSchema;
  compensation: true;
}): RequestDefinition<TName, TPayloadSchema, TResponseSchema, true>;
export function defineRequest<
  TName extends string,
  TPayloadSchema extends JsonSchemaConstraint,
  TResponseSchema extends JsonSchemaConstraint,
>(config: {
  name: TName;
  payload: TPayloadSchema;
  response: TResponseSchema;
}): RequestDefinition<TName, TPayloadSchema, TResponseSchema>;
export function defineRequest(config: {
  name: string;
  payload: JsonSchemaConstraint;
  response: JsonSchemaConstraint;
  compensation?: RequestCompensationDefinition<any>;
}): RequestDefinition<any, any, any, any> {
  if (!config.name || typeof config.name !== "string") {
    throw new Error("Request name must be a non-empty string");
  }
  if (!config.payload || !("~standard" in config.payload)) {
    throw new Error("Request payload must be a standard schema");
  }
  if (!config.response || !("~standard" in config.response)) {
    throw new Error("Request response must be a standard schema");
  }
  if (config.compensation !== undefined) {
    if (config.compensation !== true) {
      if (
        typeof config.compensation !== "object" ||
        config.compensation === null ||
        Array.isArray(config.compensation)
      ) {
        throw new Error("Request compensation must be true or an object");
      }
      if (
        config.compensation.result !== undefined &&
        !isStandardSchema(config.compensation.result)
      ) {
        throw new Error("Request compensation result must be a standard schema");
      }
    }
  }

  return {
    name: config.name,
    payload: config.payload,
    response: config.response,
    compensation: config.compensation,
    registerHandler: () => noopUnsubscribe,
  } as RequestDefinition<any, any, any, any>;
}

export function registerRequestCompensationHandler<
  TPayloadSchema extends JsonSchemaConstraint,
  TResponseSchema extends JsonSchemaConstraint,
  TCompensation extends RequestCompensationDefinition<any>,
>(
  definition: RequestDefinition<string, TPayloadSchema, TResponseSchema, TCompensation>,
  handler: (
    ctx: { signal: AbortSignal },
    payload: StandardSchemaV1.InferOutput<TPayloadSchema>,
    info: RequestCompensationInfo<StandardSchemaV1.InferOutput<TResponseSchema>>,
  ) => Promise<RequestCompensationHandlerResult<TCompensation> | typeof MANUAL>,
  options: RequestCompensationHandlerOptions<
    StandardSchemaV1.InferOutput<TPayloadSchema>,
    StandardSchemaV1.InferOutput<TResponseSchema>,
    RequestCompensationHandlerResult<TCompensation>,
    typeof MANUAL
  >,
): Unsubscribe {
  if (!("compensation" in definition)) {
    throw new Error("Request compensation handler requires a compensable request");
  }
  if (typeof handler !== "function") {
    throw new Error("Request compensation handler must be a function");
  }
  if (!options || typeof options !== "object" || !options.retryPolicy) {
    throw new Error("Request compensation handler requires a retry policy");
  }
  return noopUnsubscribe;
}

// =============================================================================
// DEFINE QUEUE
// =============================================================================

/**
 * Define a global durable queue.
 */
export function defineQueue<
  TName extends string,
  TMessageSchema extends JsonSchemaConstraint,
>(config: {
  name: TName;
  message: TMessageSchema;
  ttlSeconds?: number;
}): QueueDefinition<TName, TMessageSchema>;
export function defineQueue(config: {
  name: string;
  message: JsonSchemaConstraint;
  ttlSeconds?: number;
}): QueueDefinition<any, any> {
  if (!config.name || typeof config.name !== "string") {
    throw new Error("Queue name must be a non-empty string");
  }
  if (!isStandardSchema(config.message)) {
    throw new Error("Queue message must be a standard schema");
  }

  return {
    name: config.name,
    message: config.message,
    ttlSeconds: config.ttlSeconds,
    registerHandler: () => noopUnsubscribe,
  };
}

// =============================================================================
// DEFINE TOPIC
// =============================================================================

/**
 * Define a global ordered topic.
 */
export function defineTopic<
  TName extends string,
  TRecordSchema extends JsonSchemaConstraint,
  TMetadataSchema extends JsonSchemaConstraint | undefined = undefined,
>(config: {
  name: TName;
  record: TRecordSchema;
  metadata?: TMetadataSchema;
  retentionSeconds?: number;
}): TopicDefinition<TName, TRecordSchema, TMetadataSchema>;
export function defineTopic(config: {
  name: string;
  record: JsonSchemaConstraint;
  metadata?: JsonSchemaConstraint;
  retentionSeconds?: number;
}): TopicDefinition<any, any, any> {
  if (!config.name || typeof config.name !== "string") {
    throw new Error("Topic name must be a non-empty string");
  }
  if (!isStandardSchema(config.record)) {
    throw new Error("Topic record must be a standard schema");
  }
  if (config.metadata !== undefined && !isStandardSchema(config.metadata)) {
    throw new Error("Topic metadata must be a standard schema");
  }

  return {
    name: config.name,
    record: config.record,
    metadata: config.metadata,
    retentionSeconds: config.retentionSeconds,
    registerConsumer: () => noopUnsubscribe,
  };
}

// =============================================================================
// DEFINE WORKFLOW HEADER
// =============================================================================

/**
 * Define a minimal workflow descriptor for use in `childWorkflows` and
 * `foreignWorkflows` references before the full workflow is defined.
 *
 * A `WorkflowHeader` captures a lightweight authoring contract — `name`,
 * optional `channels`, `args`, `metadata`, and `result` — with no
 * implementation. It exists to break circular workflow dependencies and enable
 * self-referential definitions while keeping declarations as a single source
 * of truth.
 *
 * For external/client-facing contracts (including streams/events), use the
 * `PublicWorkflowHeader` type.
 * Spread it into `defineWorkflow({ ...header, ... })` so the full definition
 * re-uses the same name and schema declarations without duplication.
 *
 * The primary use case is breaking circular references between workflows that
 * reference each other, and enabling self-referential (recursive) workflows.
 *
 * @example
 * ```typescript
 * // Break a circular reference: worker ↔ manager
 * const managerHeader = defineWorkflowHeader({
 *   name: "schedulerManager",
 *   channels: { workerDone: WorkerDonePayload },
 * });
 *
 * const workerWorkflow = defineWorkflow({
 *   ...workerHeader,
 *   foreignWorkflows: { manager: managerHeader },
 *   execute: async (ctx, args) => { ... },
 * });
 *
 * const managerWorkflow = defineWorkflow({
 *   ...managerHeader,           // spreads name + channels
 *   args: ManagerArgs,          // adds implementation-only fields
 *   childWorkflows: { worker: workerWorkflow },
 *   execute: async (ctx, args) => { ... },
 * });
 *
 * // Self-referential workflow (recursive tree)
 * const treeHeader = defineWorkflowHeader({ name: "tree", args: TreeArgs });
 * const treeWorkflow = defineWorkflow({
 *   ...treeHeader,
 *   childWorkflows: { subtree: treeHeader },
 *   execute: async (ctx, args) => { ... },
 * });
 * ```
 */
export function defineWorkflowHeader<
  TName extends string,
  TChannels extends ChannelDefinitions = Record<string, never>,
  TArgs extends JsonSchemaConstraint = StandardSchemaV1<void, void>,
  TMetadata extends JsonObjectSchemaConstraint = StandardSchemaV1<void, void>,
  TResult extends JsonSchemaConstraint = StandardSchemaV1<void, void>,
  TErrors extends WorkflowErrorDefinitions = Record<string, never>,
>(config: {
  name: TName;
  channels?: TChannels;
  args?: TArgs;
  metadata?: TMetadata;
  result?: TResult;
  errors?: TErrors;
}): WorkflowHeader<TName, TChannels, TArgs, TMetadata, TResult, TErrors> {
  if (!config.name || typeof config.name !== "string") {
    throw new Error("Workflow name must be a non-empty string");
  }
  if (config.channels !== undefined) {
    if (typeof config.channels !== "object" || Array.isArray(config.channels)) {
      throw new Error("channels must be an object");
    }
    for (const [name, schema] of Object.entries(config.channels)) {
      if (!schema || typeof schema !== "object" || !("~standard" in schema)) {
        throw new Error(`Channel '${name}' must have a standard schema`);
      }
    }
  }
  if (config.args !== undefined) {
    if (
      !config.args ||
      typeof config.args !== "object" ||
      !("~standard" in config.args)
    ) {
      throw new Error("args must be a standard schema");
    }
  }
  if (config.metadata !== undefined) {
    if (
      !config.metadata ||
      typeof config.metadata !== "object" ||
      !("~standard" in config.metadata)
    ) {
      throw new Error("metadata must be a standard schema");
    }
  }
  if (config.result !== undefined) {
    if (
      !config.result ||
      typeof config.result !== "object" ||
      !("~standard" in config.result)
    ) {
      throw new Error("result must be a standard schema");
    }
  }
  if (config.errors !== undefined) {
    validateErrorDefinitions(config.errors, "errors");
  }
  return config as WorkflowHeader<TName, TChannels, TArgs, TMetadata, TResult, TErrors>;
}

// =============================================================================
// DEFINE WORKFLOW
// =============================================================================

/**
 * Define a workflow with full type safety.
 *
 * The body is a single sequential program. Concurrency comes from dispatched
 * entries (steps, requests, attached child workflows) the body awaits.
 * Structured-concurrency orchestration is provided by `ctx.scope`, `ctx.all`,
 * `ctx.first`, `ctx.atLeast`, `ctx.atMost`, and `ctx.some`.
 *
 * Compensation is declared on the step or request that owns the action; each
 * invocation produces a per-instance compensation block.
 *
 * Errors are declared on `defineWorkflow.errors` and thrown via
 * `ctx.errors.X(message, details?)`.
 *
 * See REFACTOR.MD for the authoritative public API.
 */
export function defineWorkflow<
  TName extends string,
  TChannels extends ChannelDefinitions = Record<string, never>,
  TStreams extends StreamDefinitions = Record<string, never>,
  TEvents extends EventDefinitions = Record<string, never>,
  TSteps extends StepDefinitions = Record<string, never>,
  TRequests extends RequestDefinitions = Record<string, never>,
  TChildWorkflows extends WorkflowDefinitions = Record<string, never>,
  TForeignWorkflows extends WorkflowDefinitions = Record<string, never>,
  TResultSchema extends JsonSchemaConstraint = StandardSchemaV1<void, void>,
  TArgs extends JsonSchemaConstraint = StandardSchemaV1<void, void>,
  TMetadata extends JsonObjectSchemaConstraint = StandardSchemaV1<void, void>,
  TErrors extends WorkflowErrorDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
>(config: {
  name: TName;
  channels?: TChannels;
  streams?: TStreams;
  events?: TEvents;
  steps?: TSteps;
  requests?: TRequests;
  childWorkflows?: TChildWorkflows;
  foreignWorkflows?: TForeignWorkflows;
  patches?: TPatches;
  rng?: TRng;
  result?: TResultSchema;
  args?: TArgs;
  metadata?: TMetadata;
  errors?: TErrors;
  retention?:
    | number
    | {
        complete: number | null;
        failed: number | null;
        terminated: number | null;
      };
  evictAfterSeconds?: number | null;
  beforeSettle?: (
    params:
      | {
          status: "complete";
          ctx: WorkflowContext<
            TChannels,
            TStreams,
            TEvents,
            TSteps,
            TRequests,
            TChildWorkflows,
            TForeignWorkflows,
            TPatches,
            TRng,
            [],
            TErrors
          >;
          args: StandardSchemaV1.InferOutput<TArgs>;
          result: StandardSchemaV1.InferOutput<TResultSchema>;
        }
      | {
          status: "failed" | "terminated";
          ctx: CompensationContext<
            TChannels,
            TStreams,
            TEvents,
            TSteps,
            TRequests,
            TChildWorkflows,
            TForeignWorkflows,
            TPatches,
            TRng
          >;
          args: StandardSchemaV1.InferOutput<TArgs>;
        },
  ) => Promise<void>;
  execute: (
    ctx: WorkflowContext<
      TChannels,
      TStreams,
      TEvents,
      TSteps,
      TRequests,
      TChildWorkflows,
      TForeignWorkflows,
      TPatches,
      TRng,
      [],
      TErrors
    >,
    args: StandardSchemaV1.InferOutput<TArgs>,
  ) => Promise<StandardSchemaV1.InferInput<TResultSchema>>;
}): WorkflowDefinition<
  TName,
  TChannels,
  TStreams,
  TEvents,
  TSteps,
  TRequests,
  TChildWorkflows,
  TForeignWorkflows,
  TResultSchema,
  TArgs,
  TMetadata,
  TErrors,
  TPatches,
  TRng
> {
  // Validate name
  if (!config.name || typeof config.name !== "string") {
    throw new Error("Workflow name must be a non-empty string");
  }

  // Validate result schema if provided
  if (config.result !== undefined) {
    if (!config.result || !("~standard" in config.result)) {
      throw new Error("result must be a standard schema");
    }
  }

  // Validate channels
  const channels = config.channels ?? ({} as TChannels);
  if (config.channels !== undefined) {
    if (typeof config.channels !== "object" || Array.isArray(config.channels)) {
      throw new Error("channels must be an object");
    }
    for (const [name, schema] of Object.entries(config.channels)) {
      if (!schema || typeof schema !== "object" || !("~standard" in schema)) {
        throw new Error(`Channel '${name}' must have a standard schema`);
      }
    }
  }

  // Validate streams
  const streams = config.streams ?? ({} as TStreams);
  if (config.streams !== undefined) {
    if (typeof config.streams !== "object" || Array.isArray(config.streams)) {
      throw new Error("streams must be an object");
    }
    for (const [name, schema] of Object.entries(config.streams)) {
      if (!schema || typeof schema !== "object" || !("~standard" in schema)) {
        throw new Error(`Stream '${name}' must have a standard schema`);
      }
    }
  }

  // Validate events
  const events = config.events ?? ({} as TEvents);
  if (config.events !== undefined) {
    if (typeof config.events !== "object" || Array.isArray(config.events)) {
      throw new Error("events must be an object");
    }
    for (const [name, value] of Object.entries(config.events)) {
      if (value !== true) {
        throw new Error(`Event '${name}' must be true`);
      }
    }
  }

  // Validate steps
  const steps = config.steps ?? ({} as TSteps);
  if (config.steps !== undefined) {
    if (typeof config.steps !== "object" || Array.isArray(config.steps)) {
      throw new Error("steps must be an object");
    }
    for (const [name, step] of Object.entries(config.steps)) {
      if (!step || typeof step !== "object") {
        throw new Error(`Step '${name}' must be a valid step definition`);
      }
      if (typeof step.execute !== "function") {
        throw new Error(`Step '${name}' must have an execute function`);
      }
    }
  }

  // Validate requests
  const requests = config.requests ?? ({} as TRequests);
  if (config.requests !== undefined) {
    if (typeof config.requests !== "object" || Array.isArray(config.requests)) {
      throw new Error("requests must be an object");
    }
    for (const [name, request] of Object.entries(config.requests)) {
      if (!request || typeof request !== "object") {
        throw new Error(`Request '${name}' must be a valid request definition`);
      }
      if (!request.name || typeof request.name !== "string") {
        throw new Error(`Request '${name}' must have a name`);
      }
      if (!request.payload || !("~standard" in request.payload)) {
        throw new Error(`Request '${name}' must have a standard payload schema`);
      }
      if (!request.response || !("~standard" in request.response)) {
        throw new Error(`Request '${name}' must have a standard response schema`);
      }
    }
  }

  // Validate childWorkflows
  const childWorkflows = config.childWorkflows ?? ({} as TChildWorkflows);
  if (config.childWorkflows !== undefined) {
    if (
      typeof config.childWorkflows !== "object" ||
      Array.isArray(config.childWorkflows)
    ) {
      throw new Error("childWorkflows must be an object");
    }
    for (const [name, wf] of Object.entries(config.childWorkflows)) {
      if (!wf || typeof wf !== "object") {
        throw new Error(
          `Child workflow '${name}' must be a valid workflow definition or header`,
        );
      }
      if (!wf.name || typeof wf.name !== "string") {
        throw new Error(`Child workflow '${name}' must have a name`);
      }
    }
  }

  // Validate foreignWorkflows
  const foreignWorkflows = config.foreignWorkflows ?? ({} as TForeignWorkflows);
  if (config.foreignWorkflows !== undefined) {
    if (
      typeof config.foreignWorkflows !== "object" ||
      Array.isArray(config.foreignWorkflows)
    ) {
      throw new Error("foreignWorkflows must be an object");
    }
    for (const [name, wf] of Object.entries(config.foreignWorkflows)) {
      if (!wf || typeof wf !== "object") {
        throw new Error(
          `Foreign workflow '${name}' must be a valid workflow definition or header`,
        );
      }
      if (!wf.name || typeof wf.name !== "string") {
        throw new Error(`Foreign workflow '${name}' must have a name`);
      }
    }
  }

  // Validate execute
  if (typeof config.execute !== "function") {
    throw new Error("execute must be a function");
  }

  // Validate arg schema if provided
  if (config.args !== undefined) {
    if (
      !config.args ||
      typeof config.args !== "object" ||
      !("~standard" in config.args)
    ) {
      throw new Error("args must be a standard schema");
    }
  }

  // Validate metadata schema if provided
  if (config.metadata !== undefined) {
    if (
      !config.metadata ||
      typeof config.metadata !== "object" ||
      !("~standard" in config.metadata)
    ) {
      throw new Error("metadata must be a standard schema");
    }
  }

  // Validate errors if provided
  const errors = config.errors ?? ({} as TErrors);
  if (config.errors !== undefined) {
    validateErrorDefinitions(config.errors, "errors");
  }

  // Validate patches if provided
  if (config.patches !== undefined) {
    if (typeof config.patches !== "object" || Array.isArray(config.patches)) {
      throw new Error("patches must be an object");
    }
    for (const [name, value] of Object.entries(config.patches)) {
      if (typeof value !== "boolean") {
        throw new Error(
          `Patch '${name}' must be a boolean (true = active, false = deprecated)`,
        );
      }
    }
  }

  // Validate rng if provided
  if (config.rng !== undefined) {
    if (typeof config.rng !== "object" || Array.isArray(config.rng)) {
      throw new Error("rng must be an object");
    }
    for (const [name, value] of Object.entries(config.rng)) {
      if (value !== true && typeof value !== "function") {
        throw new Error(
          `RNG '${name}' must be true (simple) or a key derivation function (parametrized)`,
        );
      }
    }
  }

  // Validate retention if provided
  if (config.retention !== undefined) {
    if (typeof config.retention === "number") {
      if (config.retention < 0) {
        throw new Error("retention must be a non-negative number (seconds)");
      }
    } else if (typeof config.retention === "object") {
      const r = config.retention;
      if (
        (r.complete !== null &&
          (typeof r.complete !== "number" || r.complete < 0)) ||
        (r.failed !== null && (typeof r.failed !== "number" || r.failed < 0)) ||
        (r.terminated !== null &&
          (typeof r.terminated !== "number" || r.terminated < 0))
      ) {
        throw new Error(
          "retention settings must have complete, failed, and terminated as non-negative numbers or null",
        );
      }
    } else {
      throw new Error("retention must be a number or RetentionSetter object");
    }
  }

  // Validate evictAfterSeconds if provided
  if (config.evictAfterSeconds !== undefined && config.evictAfterSeconds !== null) {
    if (
      typeof config.evictAfterSeconds !== "number" ||
      config.evictAfterSeconds <= 0
    ) {
      throw new Error("evictAfterSeconds must be a positive number or null");
    }
  }

  if (
    config.beforeSettle !== undefined &&
    typeof config.beforeSettle !== "function"
  ) {
    throw new Error("beforeSettle must be a function");
  }

  const patches = config.patches ?? ({} as TPatches);
  const rng = config.rng ?? ({} as TRng);

  return {
    ...config,
    channels,
    streams,
    events,
    steps,
    requests,
    childWorkflows,
    foreignWorkflows,
    errors,
    patches,
    rng,
  } as WorkflowDefinition<
    TName,
    TChannels,
    TStreams,
    TEvents,
    TSteps,
    TRequests,
    TChildWorkflows,
    TForeignWorkflows,
    TResultSchema,
    TArgs,
    TMetadata,
    TErrors,
    TPatches,
    TRng
  >;
}
