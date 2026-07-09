import type { StandardSchemaV1 } from "./types/standard-schema";
import type {
  StepDefinition,
  StepCompensationDefinition,
  MaximalStepCompensationDefinition,
  NonCompensableStepDefinitions,
  RequestDefinition,
  RequestCompensationConfig,
  RequestCompensationDefinition,
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
  JsonSchemaConstraint,
  JsonObjectSchemaConstraint,
  WorkflowExecuteContext,
  PatchDefinitions,
  RngDefinitions,
  WorkflowErrorDefinitions,
  ErrorDefinitions,
  WorkflowInterface,
  WorkflowImplementInput,
  StepInterfaces,
  RequestInterfaces,
  QueueInterfaces,
  StepInterface,
  StepCompensationInterface,
} from "./types";
import type {
  StepsFromInterfaces,
  RequestsFromInterfaces,
  QueuesFromInterfaces,
} from "./types/definitions/workflow-contract";

export {
  AttemptError,
  QueueHandlerDeclaredError,
  RequestHandlerDeclaredError,
  UnrecoverableError,
} from "./types/results";

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
 * Author `execute` and optional `retryPolicy` for the forward path. When the step
 * must be undoable, supply `compensation` with an `undo` callback (and optional
 * nested primitives); that lives on the definition, not on each call site.
 *
 * In both `WorkflowContext` and `CompensationContext`, `ctx.steps.<name>` is a
 * `StepAccessor`: calling it returns a `StepEntry` of the declared result type.
 * Pass `{ retry }` to override retries for that invocation, or `{ timeout, retry? }`
 * to get a `StepEntry` that resolves to `TimeoutResult` instead of the raw result.
 * Unhandled step failures in the workflow body terminate the workflow via the
 * declared error model.
 *
 * Compensation `undo` runs under `CompensationContext` with the same accessor
 * shape; it must not throw—handle failures inside `undo` and surface outcomes via
 * the optional compensation `result` schema when you need structured data.
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
 *   execute: async (args, { signal }) => {
 *     const res = await fetch('https://api.flights.com/book', {
 *       method: 'POST',
 *       body: JSON.stringify(args),
 *       signal,
 *     });
 *     return res.json();
 *   },
 *   retryPolicy: { intervalSeconds: 2, backoffRate: 1.5 },
 * });
 *
 * const cancelFlight = defineStep({
 *   name: 'cancelFlight',
 *   args: z.object({ destination: z.string(), customerId: z.string() }),
 *   result: z.object({ ok: z.boolean() }),
 *   execute: async (args, { signal }) => {
 *     await fetch('https://api.flights.com/cancel-by-route', {
 *       method: 'POST',
 *       body: JSON.stringify(args),
 *       signal,
 *     });
 *     return { ok: true };
 *   },
 *   retryPolicy: { intervalSeconds: 5, backoffRate: 1.2 },
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
  TCompChildren extends WorkflowDefinitions = Record<string, never>,
  TCompExternalWorkflows extends WorkflowDefinitions = Record<string, never>,
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
    TCompChildren,
    TCompExternalWorkflows,
    TCompensationResultSchema
  >;
  execute: (
    args: StandardSchemaV1.InferOutput<TArgsSchema>,
    opts: { signal: AbortSignal },
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
    TCompChildren,
    TCompExternalWorkflows,
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
    args: StandardSchemaV1.InferOutput<TArgsSchema>,
    opts: { signal: AbortSignal },
  ) => Promise<StandardSchemaV1.InferInput<TResultSchema>>;
  retryPolicy?: RetryPolicyOptions;
}): StepDefinition<TName, TArgsSchema, TResultSchema>;
export function defineStep(config: {
  name: string;
  args: JsonSchemaConstraint;
  result: JsonSchemaConstraint;
  compensation?: MaximalStepCompensationDefinition;
  execute: (args: unknown, opts: { signal: AbortSignal }) => Promise<unknown>;
  retryPolicy?: RetryPolicyOptions;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- widened return for runtime-checked overload
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches widened overload return
  } as StepDefinition<any, any, any, any>;
}

// =============================================================================
// DEFINE STEP INTERFACE
// =============================================================================

/**
 * Declare a step contract without `execute` / `undo`, then call `.implement()`
 * for a type-checked `StepDefinition`.
 */
export function defineStepInterface<
  TName extends string,
  TArgsSchema extends JsonSchemaConstraint,
  TResultSchema extends JsonSchemaConstraint,
  TCompensation extends StepCompensationInterface | undefined = undefined,
>(
  config: StepInterface<TName, TArgsSchema, TResultSchema, TCompensation>,
): StepInterface<TName, TArgsSchema, TResultSchema, TCompensation> & {
  readonly __nataliaAuthoringKind: "step-interface";
  implement: (
    impl: TCompensation extends undefined
      ? {
          execute: (
            args: StandardSchemaV1.InferOutput<TArgsSchema>,
            opts: { signal: AbortSignal },
          ) => Promise<StandardSchemaV1.InferInput<TResultSchema>>;
          retryPolicy?: RetryPolicyOptions;
        }
      : {
          execute: (
            args: StandardSchemaV1.InferOutput<TArgsSchema>,
            opts: { signal: AbortSignal },
          ) => Promise<StandardSchemaV1.InferInput<TResultSchema>>;
          retryPolicy?: RetryPolicyOptions;
          compensation: StepCompensationDefinition<
            TArgsSchema,
            TResultSchema,
            ChannelDefinitions,
            StreamDefinitions,
            EventDefinitions,
            AttributeDefinitions,
            NonCompensableStepDefinitions,
            NonCompensableRequestDefinitions,
            QueueDefinitions,
            TopicDefinitions,
            WorkflowDefinitions,
            WorkflowDefinitions,
            JsonSchemaConstraint | undefined
          >;
        },
  ) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors widened `defineStep` compensation slot for heterogeneous `implement` payloads
    StepDefinition<TName, TArgsSchema, TResultSchema, TCompensation extends undefined ? undefined : any>;
} {
  if (!config.name || typeof config.name !== "string") {
    throw new Error("Step name must be a non-empty string");
  }
  if (typeof (config as { execute?: unknown }).execute === "function") {
    throw new Error("Step interface must not include execute — use implement()");
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
    if (typeof (config.compensation as { undo?: unknown }).undo === "function") {
      throw new Error("Step interface compensation must not include undo — add it in implement()");
    }
    if ((config.compensation as { externalWorkflows?: unknown }).externalWorkflows !== undefined) {
      throw new Error(
        "Step interface compensation must not include externalWorkflows — add it in implement()",
      );
    }
  }

  return {
    ...config,
    __nataliaAuthoringKind: "step-interface" as const,
    implement: (impl) => {
      const mergedComp =
        config.compensation === undefined
          ? undefined
          : {
              ...config.compensation,
              ...(impl as { compensation?: object }).compensation,
            };
      return defineStep({
        name: config.name,
        args: config.args,
        result: config.result,
        retryPolicy: (impl as { retryPolicy?: RetryPolicyOptions }).retryPolicy ?? config.retryPolicy,
        execute: (impl as {
          execute: (
            args: StandardSchemaV1.InferOutput<TArgsSchema>,
            opts: { signal: AbortSignal },
          ) => Promise<StandardSchemaV1.InferInput<TResultSchema>>;
        }).execute,
        compensation: mergedComp,
      } as Parameters<typeof defineStep>[0]);
    },
  } as StepInterface<TName, TArgsSchema, TResultSchema, TCompensation> & {
    readonly __nataliaAuthoringKind: "step-interface";
    implement: (
      impl: TCompensation extends undefined
        ? {
            execute: (
              args: StandardSchemaV1.InferOutput<TArgsSchema>,
              opts: { signal: AbortSignal },
            ) => Promise<StandardSchemaV1.InferInput<TResultSchema>>;
            retryPolicy?: RetryPolicyOptions;
          }
        : {
            execute: (
              args: StandardSchemaV1.InferOutput<TArgsSchema>,
              opts: { signal: AbortSignal },
            ) => Promise<StandardSchemaV1.InferInput<TResultSchema>>;
            retryPolicy?: RetryPolicyOptions;
            compensation: StepCompensationDefinition<
              TArgsSchema,
              TResultSchema,
              ChannelDefinitions,
              StreamDefinitions,
              EventDefinitions,
              AttributeDefinitions,
              NonCompensableStepDefinitions,
              NonCompensableRequestDefinitions,
              QueueDefinitions,
              TopicDefinitions,
              WorkflowDefinitions,
              WorkflowDefinitions,
              JsonSchemaConstraint | undefined
            >;
          },
    ) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cast return mirrors widened `defineStep` compensation slot
      StepDefinition<TName, TArgsSchema, TResultSchema, TCompensation extends undefined ? undefined : any>;
  };
}

// =============================================================================
// DEFINE REQUEST
// =============================================================================

/**
 * Define a typed request-response interaction.
 *
 * See `RequestDefinition` for compensation shapes. Handlers register on
 * `client.requests.<definitionName>`.
 */
export function defineRequest<
  TName extends string,
  TPayloadSchema extends JsonSchemaConstraint,
  TResponseSchema extends JsonSchemaConstraint,
  TErrors extends ErrorDefinitions,
  TCompensationResultSchema extends JsonSchemaConstraint | undefined = undefined,
  TCompensationErrors extends ErrorDefinitions = Record<string, never>,
>(config: {
  name: TName;
  payload: TPayloadSchema;
  response: TResponseSchema;
  errors: TErrors;
  compensation: RequestCompensationConfig<
    TCompensationResultSchema,
    TCompensationErrors
  >;
}): RequestDefinition<
  TName,
  TPayloadSchema,
  TResponseSchema,
  TErrors,
  RequestCompensationConfig<TCompensationResultSchema, TCompensationErrors>
>;
export function defineRequest<
  TName extends string,
  TPayloadSchema extends JsonSchemaConstraint,
  TResponseSchema extends JsonSchemaConstraint,
  TCompensationResultSchema extends JsonSchemaConstraint | undefined = undefined,
  TCompensationErrors extends ErrorDefinitions = Record<string, never>,
>(config: {
  name: TName;
  payload: TPayloadSchema;
  response: TResponseSchema;
  compensation: RequestCompensationConfig<
    TCompensationResultSchema,
    TCompensationErrors
  >;
}): RequestDefinition<
  TName,
  TPayloadSchema,
  TResponseSchema,
  Record<string, never>,
  RequestCompensationConfig<TCompensationResultSchema, TCompensationErrors>
>;
export function defineRequest<
  TName extends string,
  TPayloadSchema extends JsonSchemaConstraint,
  TResponseSchema extends JsonSchemaConstraint,
  TErrors extends ErrorDefinitions,
>(config: {
  name: TName;
  payload: TPayloadSchema;
  response: TResponseSchema;
  errors: TErrors;
  compensation: true;
}): RequestDefinition<TName, TPayloadSchema, TResponseSchema, TErrors, true>;
export function defineRequest<
  TName extends string,
  TPayloadSchema extends JsonSchemaConstraint,
  TResponseSchema extends JsonSchemaConstraint,
  TErrors extends ErrorDefinitions,
>(config: {
  name: TName;
  payload: TPayloadSchema;
  response: TResponseSchema;
  errors: TErrors;
}): RequestDefinition<TName, TPayloadSchema, TResponseSchema, TErrors>;
export function defineRequest<
  TName extends string,
  TPayloadSchema extends JsonSchemaConstraint,
  TResponseSchema extends JsonSchemaConstraint,
>(config: {
  name: TName;
  payload: TPayloadSchema;
  response: TResponseSchema;
  compensation: true;
}): RequestDefinition<
  TName,
  TPayloadSchema,
  TResponseSchema,
  Record<string, never>,
  true
>;
export function defineRequest<
  TName extends string,
  TPayloadSchema extends JsonSchemaConstraint,
  TResponseSchema extends JsonSchemaConstraint,
>(config: {
  name: TName;
  payload: TPayloadSchema;
  response: TResponseSchema;
}): RequestDefinition<
  TName,
  TPayloadSchema,
  TResponseSchema,
  Record<string, never>,
  undefined
>;
export function defineRequest<
  TName extends string,
  TPayloadSchema extends JsonSchemaConstraint,
  TResponseSchema extends JsonSchemaConstraint,
  TErrors extends ErrorDefinitions = Record<string, never>,
  TCompensation extends
    | RequestCompensationDefinition<
        JsonSchemaConstraint | undefined,
        ErrorDefinitions
      >
    | undefined = undefined,
>(config: {
  name: TName;
  payload: TPayloadSchema;
  response: TResponseSchema;
  errors?: TErrors;
  compensation?: TCompensation;
}): RequestDefinition<
  TName,
  TPayloadSchema,
  TResponseSchema,
  TErrors,
  TCompensation
> {
  if (!config.name || typeof config.name !== "string") {
    throw new Error("Request name must be a non-empty string");
  }
  if (!config.payload || !("~standard" in config.payload)) {
    throw new Error("Request payload must be a standard schema");
  }
  if (!config.response || !("~standard" in config.response)) {
    throw new Error("Request response must be a standard schema");
  }
  if (config.errors !== undefined) {
    for (const [key, definition] of Object.entries(config.errors)) {
      if (definition !== true && !isStandardSchema(definition)) {
        throw new Error(
          `Request error "${key}" must be \`true\` or a standard schema`,
        );
      }
    }
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
        "result" in config.compensation &&
        config.compensation.result !== undefined &&
        !isStandardSchema(config.compensation.result)
      ) {
        throw new Error("Request compensation result must be a standard schema");
      }
      if (config.compensation.errors !== undefined) {
        for (const [key, definition] of Object.entries(config.compensation.errors)) {
          if (definition !== true && !isStandardSchema(definition)) {
            throw new Error(
              `Request compensation error "${key}" must be \`true\` or a standard schema`,
            );
          }
        }
      }
    }
  }

  return {
    name: config.name,
    payload: config.payload,
    response: config.response,
    errors: config.errors,
    compensation: config.compensation,
  } as RequestDefinition<
    TName,
    TPayloadSchema,
    TResponseSchema,
    TErrors,
    TCompensation
  >;
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
  TDefaultTtl extends number | Date | null | undefined = undefined,
>(config: {
  name: TName;
  message: TMessageSchema;
  defaultDelay?: number | Date | 0;
  defaultTtl?: TDefaultTtl;
}): QueueDefinition<TName, TMessageSchema, Record<string, never>, TDefaultTtl>;
export function defineQueue<
  TName extends string,
  TMessageSchema extends JsonSchemaConstraint,
  TErrors extends ErrorDefinitions,
  TDefaultTtl extends number | Date | null | undefined = undefined,
>(config: {
  name: TName;
  message: TMessageSchema;
  errors: TErrors;
  defaultDelay?: number | Date | 0;
  defaultTtl?: TDefaultTtl;
}): QueueDefinition<TName, TMessageSchema, TErrors, TDefaultTtl>;
export function defineQueue<
  TName extends string,
  TMessageSchema extends JsonSchemaConstraint,
  TErrors extends ErrorDefinitions = Record<string, never>,
  TDefaultTtl extends number | Date | null | undefined = undefined,
>(config: {
  name: TName;
  message: TMessageSchema;
  errors?: TErrors;
  defaultDelay?: number | Date | 0;
  defaultTtl?: TDefaultTtl;
}): QueueDefinition<TName, TMessageSchema, TErrors, TDefaultTtl> {
  if (!config.name || typeof config.name !== "string") {
    throw new Error("Queue name must be a non-empty string");
  }
  if (!isStandardSchema(config.message)) {
    throw new Error("Queue message must be a standard schema");
  }
  if (config.errors !== undefined) {
    for (const [key, definition] of Object.entries(config.errors)) {
      if (definition !== true && !isStandardSchema(definition)) {
        throw new Error(
          `Queue error "${key}" must be \`true\` or a standard schema`,
        );
      }
    }
  }

  return {
    name: config.name,
    message: config.message,
    ...(config.errors !== undefined ? { errors: config.errors } : {}),
    defaultDelay: config.defaultDelay,
    defaultTtl: config.defaultTtl,
  };
}

// =============================================================================
// DEFINE TOPIC
// =============================================================================

/**
 * Define a global ordered topic.
 *
 * Consumer registration will live on the client (not implemented yet).
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
}): TopicDefinition<string, JsonSchemaConstraint, JsonSchemaConstraint | undefined> {
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
  };
}

// =============================================================================
// DEFINE WORKFLOW HEADER
// =============================================================================

const WORKFLOW_HEADER_LOCKED_IN_EXTEND = [
  "name",
  "channels",
  "args",
  "metadata",
  "result",
  "errors",
] as const;

type ExtStreamsSel<Ext> = Ext extends { streams?: infer St }
  ? St extends StreamDefinitions
    ? St
    : Record<string, never>
  : Record<string, never>;

type ExtEventsSel<Ext> = Ext extends { events?: infer Ev }
  ? Ev extends EventDefinitions
    ? Ev
    : Record<string, never>
  : Record<string, never>;

type ExtAttributesSel<Ext> = Ext extends { attributes?: infer At }
  ? At extends AttributeDefinitions
    ? At
    : Record<string, never>
  : Record<string, never>;

type ExtStepsSel<Ext> = Ext extends { steps?: infer S }
  ? S extends StepInterfaces
    ? S
    : Record<string, never>
  : Record<string, never>;

type ExtRequestsSel<Ext> = Ext extends { requests?: infer R }
  ? R extends RequestInterfaces
    ? R
    : Record<string, never>
  : Record<string, never>;

type ExtQueuesSel<Ext> = Ext extends { queues?: infer Q }
  ? Q extends QueueInterfaces
    ? Q
    : Record<string, never>
  : Record<string, never>;

type ExtChildrenSel<Ext> = Ext extends { childWorkflows?: infer C }
  ? C extends WorkflowDefinitions
    ? C
    : Record<string, never>
  : Record<string, never>;

type ExtPatchesSel<Ext> = Ext extends { patches?: infer P }
  ? P extends PatchDefinitions
    ? P
    : Record<string, never>
  : Record<string, never>;

type ExtRngSel<Ext> = Ext extends { rng?: infer G }
  ? G extends RngDefinitions
    ? G
    : Record<string, never>
  : Record<string, never>;

type ForbidWorkflowHeaderOverrides = {
  readonly name?: never;
  readonly channels?: never;
  readonly args?: never;
  readonly metadata?: never;
  readonly result?: never;
  readonly errors?: never;
};

function assertWorkflowHeaderExtendHasNoLockedKeys(extension: object): void {
  for (const k of WORKFLOW_HEADER_LOCKED_IN_EXTEND) {
    if (Object.prototype.hasOwnProperty.call(extension, k)) {
      throw new Error(
        `defineWorkflowHeader(...).extend() must not receive header field "${k}" — it is fixed on the header.`,
      );
    }
  }
}

/**
 * Define a minimal workflow descriptor for use in `childWorkflows` and
 * `externalWorkflows` references before the full workflow is defined.
 *
 * A `WorkflowHeader` captures a lightweight authoring contract — `name`,
 * required `args`, and optional `channels`, `metadata`, and `result` — with no
 * implementation. It exists to break circular workflow dependencies and enable
 * self-referential definitions while keeping declarations as a single source
 * of truth.
 *
 * For the **header → interface** step, call **`.extend({ ... })`** so streams,
 * events, steps, and other public fields are additive only (header fields cannot
 * be overridden). Then call **`.implement({ execute, ... })`** for the runnable
 * workflow definition.
 *
 * The primary use case is breaking circular references between workflows that
 * reference each other, and enabling self-referential (recursive) workflows.
 *
 * @example
 * ```typescript
 * // Break a circular reference: worker ↔ manager
 * const workerHeader = defineWorkflowHeader({
 *   name: "worker",
 *   args: z.undefined(),
 *   channels: { task: TaskPayload },
 * });
 * const managerHeader = defineWorkflowHeader({
 *   name: "schedulerManager",
 *   args: z.undefined(),
 *   channels: { workerDone: WorkerDonePayload },
 * });
 *
 * const workerWorkflow = workerHeader.extend({}).implement({
 *   externalWorkflows: { manager: managerHeader },
 *   execute: async (ctx) => { ... },
 * });
 *
 * const managerWorkflow = managerHeader.extend({
 *   streams: { audit: AuditRow },
 *   steps: { notify: notifyStepInterface },
 * }).implement({
 *   childWorkflows: { attached: { worker: workerWorkflow } },
 *   steps: { notify: notifyStep },
 *   execute: async (ctx) => { ... },
 * });
 *
 * // Self-referential workflow (recursive tree)
 * const treeHeader = defineWorkflowHeader({ name: "tree", args: TreeArgs });
 * const treeWorkflow = treeHeader.extend({
 *   childWorkflows: { attached: { subtree: treeHeader } },
 * }).implement({
 *   execute: async (ctx) => { ... },
 * });
 * ```
 */
export function defineWorkflowHeader<
  TName extends string,
  TArgs extends JsonSchemaConstraint,
  TChannels extends ChannelDefinitions = Record<string, never>,
  TMetadata extends JsonObjectSchemaConstraint = StandardSchemaV1<void, void>,
  TResult extends JsonSchemaConstraint = StandardSchemaV1<void, void>,
  TErrors extends WorkflowErrorDefinitions = Record<string, never>,
  TIdempotencyKeyFactory extends (args: StandardSchemaV1.InferOutput<TArgs>) => string =
    (args: StandardSchemaV1.InferOutput<TArgs>) => never,
>(config: {
  name: TName;
  args: TArgs;
  channels?: TChannels;
  metadata?: TMetadata;
  result?: TResult;
  errors?: TErrors;
  idempotencyKeyFactory?: TIdempotencyKeyFactory;
}) {
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
  if (
    !config.args ||
    typeof config.args !== "object" ||
    !("~standard" in config.args)
  ) {
    throw new Error("args must be a standard schema");
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
  const headerAuthoring = {
    ...config,
    __nataliaAuthoringKind: "header" as const,
    extend: <const Ext extends object>(
      extension: Ext & ForbidWorkflowHeaderOverrides,
    ) => {
      assertWorkflowHeaderExtendHasNoLockedKeys(extension);
      return defineWorkflowInterface<
        TName,
        TChannels,
        ExtStreamsSel<Ext>,
        ExtEventsSel<Ext>,
        ExtAttributesSel<Ext>,
        ExtStepsSel<Ext>,
        ExtRequestsSel<Ext>,
        ExtQueuesSel<Ext>,
        ExtChildrenSel<Ext>,
        TResult,
        TArgs,
        TMetadata,
        TErrors,
        ExtPatchesSel<Ext>,
        ExtRngSel<Ext>
      >({
        ...config,
        ...extension,
      } as WorkflowInterface<
        TName,
        TChannels,
        ExtStreamsSel<Ext>,
        ExtEventsSel<Ext>,
        ExtAttributesSel<Ext>,
        ExtStepsSel<Ext>,
        ExtRequestsSel<Ext>,
        ExtQueuesSel<Ext>,
        ExtChildrenSel<Ext>,
        TResult,
        TArgs,
        TMetadata,
        TErrors,
        ExtPatchesSel<Ext>,
        ExtRngSel<Ext>
      >);
    },
  };
  return headerAuthoring;
}

// =============================================================================
// DEFINE WORKFLOW INTERFACE
// =============================================================================

/**
 * Declare the full workflow contract (streams, events, childWorkflows, requests, step
 * interfaces, …) without `execute` or step bodies. Prefer
 * **`defineWorkflowHeader(...).extend({ ... })`** for the header → interface step
 * so header fields stay fixed, then call **`.implement()`** for a type-checked
 * `WorkflowDefinition`.
 *
 * **`externalWorkflows`** workflows are **not** part of this public contract — pass them on
 * **`.implement({ externalWorkflows, execute, … })`** so `ctx.externalWorkflows` is typed for the
 * implementation only.
 */
export function defineWorkflowInterface<
  TName extends string,
  TChannels extends ChannelDefinitions = Record<string, never>,
  TStreams extends StreamDefinitions = Record<string, never>,
  TEvents extends EventDefinitions = Record<string, never>,
  TAttributes extends AttributeDefinitions = Record<string, never>,
  TSteps extends StepInterfaces = Record<string, never>,
  TRequests extends RequestInterfaces = Record<string, never>,
  TQueues extends QueueInterfaces = Record<string, never>,
  TChildren extends WorkflowDefinitions = Record<string, never>,
  TResultSchema extends JsonSchemaConstraint = StandardSchemaV1<void, void>,
  TArgs extends JsonSchemaConstraint = StandardSchemaV1<void, void>,
  TMetadata extends JsonObjectSchemaConstraint = StandardSchemaV1<void, void>,
  TErrors extends WorkflowErrorDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
>(
  config: WorkflowInterface<
    TName,
    TChannels,
    TStreams,
    TEvents,
    TAttributes,
    TSteps,
    TRequests,
    TQueues,
    TChildren,
    TResultSchema,
    TArgs,
    TMetadata,
    TErrors,
    TPatches,
    TRng
  >,
): WorkflowInterface<
  TName,
  TChannels,
  TStreams,
  TEvents,
  TAttributes,
  TSteps,
  TRequests,
  TQueues,
  TChildren,
  TResultSchema,
  TArgs,
  TMetadata,
  TErrors,
  TPatches,
  TRng
> & {
  readonly __nataliaAuthoringKind: "interface";
  implement: <TExternalWorkflows extends WorkflowDefinitions = Record<string, never>>(
    impl: WorkflowImplementInput<
      TName,
      TChannels,
      TStreams,
      TEvents,
      TAttributes,
      TSteps,
      TRequests,
      TQueues,
      TChildren,
      TExternalWorkflows,
      TResultSchema,
      TArgs,
      TMetadata,
      TErrors,
      TPatches,
      TRng
    >,
  ) => WorkflowDefinition<
    TName,
    TChannels,
    TStreams,
    TEvents,
    TAttributes,
    StepsFromInterfaces<TSteps>,
    RequestsFromInterfaces<TRequests>,
    QueuesFromInterfaces<TQueues>,
    TChildren,
    TExternalWorkflows,
    TResultSchema,
    TArgs,
    TMetadata,
    TErrors,
    TPatches,
    TRng
  > & { readonly __nataliaAuthoringKind: "definition" };
} {
  if (!config.name || typeof config.name !== "string") {
    throw new Error("Workflow name must be a non-empty string");
  }
  if (config.result !== undefined) {
    if (!config.result || !("~standard" in config.result)) {
      throw new Error("result must be a standard schema");
    }
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
  if (config.attributes !== undefined) {
    if (typeof config.attributes !== "object" || Array.isArray(config.attributes)) {
      throw new Error("attributes must be an object");
    }
    for (const [name, schema] of Object.entries(config.attributes)) {
      if (!schema || typeof schema !== "object" || !("~standard" in schema)) {
        throw new Error(`Attribute '${name}' must have a standard schema`);
      }
    }
  }
  if (config.steps !== undefined) {
    if (typeof config.steps !== "object" || Array.isArray(config.steps)) {
      throw new Error("steps must be an object");
    }
    for (const [name, step] of Object.entries(config.steps)) {
      if (!step || typeof step !== "object") {
        throw new Error(`Step interface '${name}' must be an object`);
      }
      if (typeof (step as { execute?: unknown }).execute === "function") {
        throw new Error(
          `Step interface '${name}' must not include execute — use defineStepInterface(...).implement(...)`,
        );
      }
      if (!(step as { name?: unknown }).name || typeof (step as { name: string }).name !== "string") {
        throw new Error(`Step interface '${name}' must have a name`);
      }
      if (
        !(step as { args?: unknown }).args ||
        typeof (step as { args: object }).args !== "object" ||
        !("~standard" in (step as { args: object }).args)
      ) {
        throw new Error(`Step interface '${name}' must have a standard args schema`);
      }
      if (
        !(step as { result?: unknown }).result ||
        typeof (step as { result: object }).result !== "object" ||
        !("~standard" in (step as { result: object }).result)
      ) {
        throw new Error(`Step interface '${name}' must have a standard result schema`);
      }
      const comp = (step as { compensation?: { undo?: unknown } }).compensation;
      if (comp !== undefined && typeof comp === "object" && comp !== null && typeof comp.undo === "function") {
        throw new Error(
          `Step interface '${name}' compensation must not include undo — add it in implement()`,
        );
      }
      if (
        comp !== undefined &&
        typeof comp === "object" &&
        comp !== null &&
        (comp as { externalWorkflows?: unknown }).externalWorkflows !== undefined
      ) {
        throw new Error(
          `Step interface '${name}' compensation must not include externalWorkflows — add it in implement()`,
        );
      }
    }
  }
  if (config.requests !== undefined) {
    if (typeof config.requests !== "object" || Array.isArray(config.requests)) {
      throw new Error("requests must be an object");
    }
    for (const [name, request] of Object.entries(config.requests)) {
      if (!request || typeof request !== "object") {
        throw new Error(`Request interface '${name}' must be an object`);
      }
      if (typeof (request as { registerHandler?: unknown }).registerHandler === "function") {
        throw new Error(
          `Request interface '${name}' must not include registerHandler — use defineRequest() inside implement()`,
        );
      }
      if (!(request as { name?: unknown }).name || typeof (request as { name: string }).name !== "string") {
        throw new Error(`Request interface '${name}' must have a name`);
      }
      if (
        !(request as { payload?: unknown }).payload ||
        typeof (request as { payload: object }).payload !== "object" ||
        !("~standard" in (request as { payload: object }).payload)
      ) {
        throw new Error(`Request interface '${name}' must have a standard payload schema`);
      }
      if (
        !(request as { response?: unknown }).response ||
        typeof (request as { response: object }).response !== "object" ||
        !("~standard" in (request as { response: object }).response)
      ) {
        throw new Error(`Request interface '${name}' must have a standard response schema`);
      }
    }
  }
  if (config.queues !== undefined) {
    if (typeof config.queues !== "object" || Array.isArray(config.queues)) {
      throw new Error("queues must be an object");
    }
    for (const [name, queue] of Object.entries(config.queues)) {
      if (!queue || typeof queue !== "object") {
        throw new Error(`Queue interface '${name}' must be an object`);
      }
      if (typeof (queue as { registerHandler?: unknown }).registerHandler === "function") {
        throw new Error(
          `Queue interface '${name}' must not include registerHandler — register on client.queues.<definitionName>`,
        );
      }
      if (!(queue as { name?: unknown }).name || typeof (queue as { name: string }).name !== "string") {
        throw new Error(`Queue interface '${name}' must have a name`);
      }
      if (
        !(queue as { message?: unknown }).message ||
        typeof (queue as { message: object }).message !== "object" ||
        !("~standard" in (queue as { message: object }).message)
      ) {
        throw new Error(`Queue interface '${name}' must have a standard message schema`);
      }
    }
  }
  if (config.childWorkflows !== undefined) {
    if (typeof config.childWorkflows !== "object" || Array.isArray(config.childWorkflows)) {
      throw new Error("childWorkflows must be an object");
    }
    for (const [name, wf] of Object.entries(config.childWorkflows)) {
      if (!wf || typeof wf !== "object") {
        throw new Error(`Child workflow '${name}' must be a valid workflow definition or header`);
      }
      if (!(wf as { name?: unknown }).name || typeof (wf as { name: string }).name !== "string") {
        throw new Error(`Child workflow '${name}' must have a name`);
      }
    }
  }
  if (
    !config.args ||
    typeof config.args !== "object" ||
    !("~standard" in config.args)
  ) {
    throw new Error("args must be a standard schema");
  }
  if (config.metadata !== undefined) {
    if (!config.metadata || typeof config.metadata !== "object" || !("~standard" in config.metadata)) {
      throw new Error("metadata must be a standard schema");
    }
  }
  if (config.errors !== undefined) {
    validateErrorDefinitions(config.errors, "errors");
  }
  if (config.patches !== undefined) {
    if (typeof config.patches !== "object" || Array.isArray(config.patches)) {
      throw new Error("patches must be an object");
    }
    for (const [name, value] of Object.entries(config.patches)) {
      if (typeof value !== "boolean") {
        throw new Error(`Patch '${name}' must be a boolean (true = active, false = deprecated)`);
      }
    }
  }
  if (config.rng !== undefined) {
    if (typeof config.rng !== "object" || Array.isArray(config.rng)) {
      throw new Error("rng must be an object");
    }
    for (const [name, value] of Object.entries(config.rng)) {
      if (value !== true && typeof value !== "function") {
        throw new Error(`RNG '${name}' must be true (simple) or a key derivation function (parametrized)`);
      }
    }
  }
  if (config.retention !== undefined) {
    if (typeof config.retention === "number") {
      if (config.retention < 0) {
        throw new Error("retention must be a non-negative number (seconds)");
      }
    } else if (typeof config.retention === "object") {
      const r = config.retention;
      if (
        (r.complete !== null && (typeof r.complete !== "number" || r.complete < 0)) ||
        (r.failed !== null && (typeof r.failed !== "number" || r.failed < 0)) ||
        (r.terminated !== null && (typeof r.terminated !== "number" || r.terminated < 0))
      ) {
        throw new Error(
          "retention settings must have complete, failed, and terminated as non-negative numbers or null",
        );
      }
    } else {
      throw new Error("retention must be a number or RetentionSetter object");
    }
  }
  if (config.evictAfterSeconds !== undefined && config.evictAfterSeconds !== null) {
    if (typeof config.evictAfterSeconds !== "number" || config.evictAfterSeconds <= 0) {
      throw new Error("evictAfterSeconds must be a positive number or null");
    }
  }

  return {
    ...config,
    __nataliaAuthoringKind: "interface" as const,
    implement: <TExternalWorkflows extends WorkflowDefinitions = Record<string, never>>(
      impl: WorkflowImplementInput<
        TName,
        TChannels,
        TStreams,
        TEvents,
        TAttributes,
        TSteps,
        TRequests,
        TQueues,
        TChildren,
        TExternalWorkflows,
        TResultSchema,
        TArgs,
        TMetadata,
        TErrors,
        TPatches,
        TRng
      >,
    ) => {
      if ((impl as { queues?: unknown }).queues !== undefined) {
        throw new Error(
          "queues must be declared on the workflow interface — pass them to extend(), not implement()",
        );
      }
      if (impl.externalWorkflows !== undefined) {
        if (typeof impl.externalWorkflows !== "object" || Array.isArray(impl.externalWorkflows)) {
          throw new Error("externalWorkflows must be an object");
        }
        for (const [name, wf] of Object.entries(impl.externalWorkflows)) {
          if (!wf || typeof wf !== "object") {
            throw new Error(`External workflow '${name}' must be a valid workflow definition or header`);
          }
          if (!(wf as { name?: unknown }).name || typeof (wf as { name: string }).name !== "string") {
            throw new Error(`External workflow '${name}' must have a name`);
          }
        }
      }
      const merged = {
        ...config,
        ...impl,
        steps: impl.steps ?? ({} as StepsFromInterfaces<TSteps>),
        requests: impl.requests ?? ({} as RequestsFromInterfaces<TRequests>),
        queues: config.queues ?? ({} as QueuesFromInterfaces<TQueues>),
        __nataliaAuthoringKind: "definition" as const,
      };
      return defineWorkflow(merged as unknown as Parameters<typeof defineWorkflow>[0]) as unknown as WorkflowDefinition<
        TName,
        TChannels,
        TStreams,
        TEvents,
        TAttributes,
        StepsFromInterfaces<TSteps>,
        RequestsFromInterfaces<TRequests>,
        QueuesFromInterfaces<TQueues>,
        TChildren,
        TExternalWorkflows,
        TResultSchema,
        TArgs,
        TMetadata,
        TErrors,
        TPatches,
        TRng
      > & { readonly __nataliaAuthoringKind: "definition" };
    },
  } as WorkflowInterface<
    TName,
    TChannels,
    TStreams,
    TEvents,
    TAttributes,
    TSteps,
    TRequests,
    TQueues,
    TChildren,
    TResultSchema,
    TArgs,
    TMetadata,
    TErrors,
    TPatches,
    TRng
  > & {
    readonly __nataliaAuthoringKind: "interface";
    implement: <TExternalWorkflows extends WorkflowDefinitions = Record<string, never>>(
      impl: WorkflowImplementInput<
        TName,
        TChannels,
        TStreams,
        TEvents,
        TAttributes,
        TSteps,
        TRequests,
        TQueues,
        TChildren,
        TExternalWorkflows,
        TResultSchema,
        TArgs,
        TMetadata,
        TErrors,
        TPatches,
        TRng
      >,
    ) => WorkflowDefinition<
      TName,
      TChannels,
      TStreams,
      TEvents,
      TAttributes,
      StepsFromInterfaces<TSteps>,
      RequestsFromInterfaces<TRequests>,
      QueuesFromInterfaces<TQueues>,
      TChildren,
      TExternalWorkflows,
      TResultSchema,
      TArgs,
      TMetadata,
      TErrors,
      TPatches,
      TRng
    > & { readonly __nataliaAuthoringKind: "definition" };
  };
}

// =============================================================================
// DEFINE WORKFLOW
// =============================================================================

/**
 * Define a workflow with full type safety.
 *
 * The body is a single sequential program. Concurrency comes from dispatched
 * entries (steps, requests, child workflows) the body awaits.
 * Structured-concurrency orchestration is provided by `ctx.scope`, `ctx.all`,
 * `ctx.first`, `ctx.atLeast`, `ctx.atMost`, and `ctx.some`.
 *
 * Compensation is declared on the step or request that owns the action; each
 * invocation produces a per-instance compensation block.
 *
 * Errors are declared on `defineWorkflow.errors` and thrown via
 * `ctx.errors.X(message, details?)`.
 *
 * `args` is required on every workflow. Use `z.undefined()` when there is no
 * start payload; `ctx.args` is then typed as `undefined`.
 *
 * See REFACTOR.MD for the authoritative public API.
 */
export function defineWorkflow<
  TName extends string,
  TArgs extends JsonSchemaConstraint,
  TChannels extends ChannelDefinitions = Record<string, never>,
  TStreams extends StreamDefinitions = Record<string, never>,
  TEvents extends EventDefinitions = Record<string, never>,
  TAttributes extends AttributeDefinitions = Record<string, never>,
  TSteps extends StepDefinitions = Record<string, never>,
  TRequests extends RequestDefinitions = Record<string, never>,
  TQueues extends QueueDefinitions = Record<string, never>,
  TChildren extends WorkflowDefinitions = Record<string, never>,
  TExternalWorkflows extends WorkflowDefinitions = Record<string, never>,
  TResultSchema extends JsonSchemaConstraint = StandardSchemaV1<void, void>,
  TMetadata extends JsonObjectSchemaConstraint = StandardSchemaV1<void, void>,
  TErrors extends WorkflowErrorDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
  TIdempotencyKeyFactory extends (args: StandardSchemaV1.InferOutput<TArgs>) => string =
    (args: StandardSchemaV1.InferOutput<TArgs>) => never,
>(config: {
  name: TName;
  channels?: TChannels;
  streams?: TStreams;
  events?: TEvents;
  attributes?: TAttributes;
  steps?: TSteps;
  requests?: TRequests;
  queues?: TQueues;
  childWorkflows?: TChildren;
  externalWorkflows?: TExternalWorkflows;
  patches?: TPatches;
  rng?: TRng;
  result?: TResultSchema;
  args: TArgs;
  metadata?: TMetadata;
  errors?: TErrors;
  idempotencyKeyFactory?: TIdempotencyKeyFactory;
  retention?:
    | number
    | {
        complete: number | null;
        failed: number | null;
        terminated: number | null;
      };
  evictAfterSeconds?: number | null;
  execute: (
    ctx: WorkflowExecuteContext<
      TChannels,
      TStreams,
      TEvents,
      TAttributes,
      TSteps,
      TRequests,
      TQueues,
      TChildren,
      TExternalWorkflows,
      TPatches,
      TRng,
      TErrors,
      TArgs
    >,
  ) => Promise<StandardSchemaV1.InferInput<TResultSchema>>;
}): WorkflowDefinition<
  TName,
  TChannels,
  TStreams,
  TEvents,
  TAttributes,
  TSteps,
  TRequests,
  TQueues,
  TChildren,
  TExternalWorkflows,
  TResultSchema,
  TArgs,
  TMetadata,
  TErrors,
  TPatches,
  TRng,
  TIdempotencyKeyFactory
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

  // Validate attributes
  const attributes = config.attributes ?? ({} as TAttributes);
  if (config.attributes !== undefined) {
    if (typeof config.attributes !== "object" || Array.isArray(config.attributes)) {
      throw new Error("attributes must be an object");
    }
    for (const [name, schema] of Object.entries(config.attributes)) {
      if (!schema || typeof schema !== "object" || !("~standard" in schema)) {
        throw new Error(`Attribute '${name}' must have a standard schema`);
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

  // Validate queues
  const queues = config.queues ?? ({} as TQueues);
  if (config.queues !== undefined) {
    if (typeof config.queues !== "object" || Array.isArray(config.queues)) {
      throw new Error("queues must be an object");
    }
    for (const [name, queue] of Object.entries(config.queues)) {
      if (!queue || typeof queue !== "object") {
        throw new Error(`Queue '${name}' must be a valid queue definition`);
      }
      if (!queue.name || typeof queue.name !== "string") {
        throw new Error(`Queue '${name}' must have a name`);
      }
      if (!queue.message || !("~standard" in queue.message)) {
        throw new Error(`Queue '${name}' must have a standard message schema`);
      }
    }
  }

  // Validate childWorkflows
  const childWorkflows = config.childWorkflows ?? ({} as TChildren);
  if (config.childWorkflows !== undefined) {
    if (typeof config.childWorkflows !== "object" || Array.isArray(config.childWorkflows)) {
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

  // Validate external workflows
  const externalWorkflows = config.externalWorkflows ?? ({} as TExternalWorkflows);
  if (config.externalWorkflows !== undefined) {
    if (typeof config.externalWorkflows !== "object" || Array.isArray(config.externalWorkflows)) {
      throw new Error("externalWorkflows must be an object");
    }
    for (const [name, wf] of Object.entries(config.externalWorkflows)) {
      if (!wf || typeof wf !== "object") {
        throw new Error(
          `External workflow '${name}' must be a valid workflow definition or header`,
        );
      }
      if (!wf.name || typeof wf.name !== "string") {
        throw new Error(`External workflow '${name}' must have a name`);
      }
    }
  }

  // Validate execute
  if (typeof config.execute !== "function") {
    throw new Error("execute must be a function");
  }

  // Validate args schema (required)
  if (
    !config.args ||
    typeof config.args !== "object" ||
    !("~standard" in config.args)
  ) {
    throw new Error("args must be a standard schema");
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

  const patches = config.patches ?? ({} as TPatches);
  const rng = config.rng ?? ({} as TRng);

  return {
    ...config,
    channels,
    streams,
    events,
    attributes,
    steps,
    requests,
    queues,
    childWorkflows,
    externalWorkflows,
    errors,
    patches,
    rng,
    __nataliaAuthoringKind: "definition" as const,
  } as WorkflowDefinition<
    TName,
    TChannels,
    TStreams,
    TEvents,
    TAttributes,
    TSteps,
    TRequests,
    TQueues,
    TChildren,
    TExternalWorkflows,
    TResultSchema,
    TArgs,
    TMetadata,
    TErrors,
    TPatches,
    TRng
  >;
}
