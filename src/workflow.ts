import type { StandardSchemaV1 } from "./types/standard-schema";
import type {
  StepDefinition,
  RetryPolicyOptions,
  ChannelDefinitions,
  StreamDefinitions,
  EventDefinitions,
  StepDefinitions,
  WorkflowDefinitions,
  WorkflowDefinition,
  WorkflowHeader,
  JsonSchemaConstraint,
  JsonObjectSchemaConstraint,
  WorkflowContext,
  CompensationContext,
  PatchDefinitions,
  RngDefinitions,
} from "./types";

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
 *   execute: async ({ signal }, destination: string, customerId: string) => {
 *     const res = await fetch('https://api.flights.com/book', {
 *       method: 'POST',
 *       body: JSON.stringify({ destination, customerId }),
 *       signal,
 *     });
 *     return res.json();
 *   },
 *   schema: FlightBookingResult,
 *   retryPolicy: { maxAttempts: 3, intervalSeconds: 2 },
 * });
 *
 * // Compensation step — used in .compensate() callbacks
 * const cancelFlight = defineStep({
 *   name: 'cancelFlight',
 *   execute: async ({ signal }, destination: string, customerId: string) => {
 *     await fetch('https://api.flights.com/cancel-by-route', {
 *       method: 'POST',
 *       body: JSON.stringify({ destination, customerId }),
 *       signal,
 *     });
 *     return { ok: true };
 *   },
 *   schema: z.object({ ok: z.boolean() }),
 *   retryPolicy: { maxAttempts: 20, intervalSeconds: 5 },
 * });
 * ```
 */
export function defineStep<
  TArgs extends unknown[],
  TResultSchema extends JsonSchemaConstraint = any,
>(config: {
  name: string;
  execute: (
    context: { signal: AbortSignal },
    ...args: TArgs
  ) => Promise<StandardSchemaV1.InferInput<TResultSchema>>;
  schema: TResultSchema;
  retryPolicy?: RetryPolicyOptions;
}): StepDefinition<TArgs, TResultSchema> {
  if (!config.name || typeof config.name !== "string") {
    throw new Error("Step name must be a non-empty string");
  }
  if (typeof config.execute !== "function") {
    throw new Error("Step execute must be a function");
  }
  if (!config.schema || !("~standard" in config.schema)) {
    throw new Error("Step schema must be a standard schema");
  }

  return {
    name: config.name,
    execute: config.execute,
    schema: config.schema,
    retryPolicy: config.retryPolicy,
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
  TChannels extends ChannelDefinitions = Record<string, never>,
  TArgs extends JsonSchemaConstraint = StandardSchemaV1<
    void,
    void
  >,
  TMetadata extends JsonObjectSchemaConstraint = StandardSchemaV1<
    void,
    void
  >,
  TResult extends JsonSchemaConstraint = StandardSchemaV1<
    void,
    void
  >,
>(config: {
  name: string;
  channels?: TChannels;
  args?: TArgs;
  metadata?: TMetadata;
  result?: TResult;
}): WorkflowHeader<TChannels, TArgs, TMetadata, TResult> {
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
  return config as WorkflowHeader<TChannels, TArgs, TMetadata, TResult>;
}

// =============================================================================
// DEFINE WORKFLOW
// =============================================================================

/**
 * Define a workflow with full type safety.
 *
 * Workflows are durable, long-running processes that:
 * - Survive process restarts via replay
 * - Communicate via channels (messages)
 * - Output data via streams
 * - Signal milestones via events
 * - Execute durable operations via steps
 *
 * **Callable thenable model:** Steps and child workflows are called directly and
 * return thenables (`StepCall<T>`, `WorkflowCall<T>`). Chain builder methods before
 * awaiting: `.compensate(cb)`, `.retry(policy)`, `.failure(cb)`, `.complete(cb)`.
 * Failure auto-terminates the workflow unless `.failure(cb)` is used.
 *
 * **Compensation:** Register per-step via `.compensate(cb)` builder.
 * `ctx.addCompensation(cb)` provides general-purpose cleanup.
 * All compensations run in LIFO order when the workflow fails.
 *
 * **Structured concurrency:** All concurrent branches run as closures inside
 * `ctx.scope(name, ...)`. Collections (Array, Map) are supported for dynamic fan-out.
 * Branches with compensated steps are compensated on scope exit.
 *
 * **Failure handling:** Concurrency primitives (match, map) support
 * `{ complete, failure }` handlers for explicit failure recovery without
 * crashing the workflow.
 *
 * **Child workflows:** `ctx.childWorkflows.*` for structured invocation;
 * `ctx.foreignWorkflows.*` for message-only access to existing instances.
 * Use child call option `{ detached: true }` for fire-and-forget mode.
 *
 * @example
 * ```typescript
 * const travelWorkflow = defineWorkflow({
 *   name: 'travel',
 *   args: TravelArgs,
 *   steps: { bookFlight, cancelFlight, bookHotel, cancelHotel },
 *   result: z.object({ bookingId: z.string() }),
 *
 *   async execute(ctx, args) {
 *     // Call step directly — failure auto-compensates
 *     const flight = await ctx.steps
 *       .bookFlight(args.destination, args.customerId)
 *       .compensate(async (compCtx) => {
 *         // No status check — compensation is always unconditional.
 *         // The step is idempotent; side effects may exist even on failure.
 *         await compCtx.steps.cancelFlight(args.destination, args.customerId);
 *       });
 *
 *     // Concurrent with scope — closures as branches
 *     const hotel = await ctx.scope("BookHotel", {
 *       a: async () => ctx.steps
 *         .bookHotel(args.city, args.checkIn, args.checkOut)
 *         .compensate(async (compCtx) => {
 *           await compCtx.steps.cancelHotel(args.city, args.checkIn, args.checkOut);
 *         }),
 *     }, async (ctx, { a }) => await a);
 *
 *     return { bookingId: flight.id };
 *   },
 * });
 * ```
 */
export function defineWorkflow<
  TState = undefined,
  TChannels extends ChannelDefinitions = Record<string, never>,
  TStreams extends StreamDefinitions = Record<string, never>,
  TEvents extends EventDefinitions = Record<string, never>,
  TSteps extends StepDefinitions = Record<string, never>,
  TChildWorkflows extends WorkflowDefinitions = Record<string, never>,
  TForeignWorkflows extends WorkflowDefinitions = Record<string, never>,
  TResultSchema extends JsonSchemaConstraint = StandardSchemaV1<
    void,
    void
  >,
  TArgs extends JsonSchemaConstraint = StandardSchemaV1<
    void,
    void
  >,
  TMetadata extends JsonObjectSchemaConstraint = StandardSchemaV1<
    void,
    void
  >,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
>(config: {
  name: string;
  state?: () => TState;
  channels?: TChannels;
  streams?: TStreams;
  events?: TEvents;
  steps?: TSteps;
  childWorkflows?: TChildWorkflows;
  foreignWorkflows?: TForeignWorkflows;
  patches?: TPatches;
  rng?: TRng;
  result?: TResultSchema;
  args?: TArgs;
  metadata?: TMetadata;
  retention?:
    | number
    | {
        complete: number | null;
        failed: number | null;
        terminated: number | null;
      };
  beforeCompensate?: (params: {
    ctx: CompensationContext<
      TState,
      TChannels,
      TStreams,
      TEvents,
      TSteps,
      TChildWorkflows,
      TForeignWorkflows,
      TPatches,
      TRng
    >;
    args: StandardSchemaV1.InferOutput<TArgs>;
  }) => Promise<void>;
  afterCompensate?: (params: {
    ctx: CompensationContext<
      TState,
      TChannels,
      TStreams,
      TEvents,
      TSteps,
      TChildWorkflows,
      TForeignWorkflows,
      TPatches,
      TRng
    >;
    args: StandardSchemaV1.InferOutput<TArgs>;
  }) => Promise<void>;
  beforeSettle?: (params:
    | {
        status: "complete";
        ctx: WorkflowContext<
          TState,
          TChannels,
          TStreams,
          TEvents,
          TSteps,
          TChildWorkflows,
          TForeignWorkflows,
          TPatches,
          TRng
        >;
        args: StandardSchemaV1.InferOutput<TArgs>;
        result: StandardSchemaV1.InferOutput<TResultSchema>;
      }
    | {
        status: "failed" | "terminated";
        ctx: CompensationContext<
          TState,
          TChannels,
          TStreams,
          TEvents,
          TSteps,
          TChildWorkflows,
          TForeignWorkflows,
          TPatches,
          TRng
        >;
        args: StandardSchemaV1.InferOutput<TArgs>;
      }) => Promise<void>;
  execute: (
    ctx: WorkflowContext<
      TState,
      TChannels,
      TStreams,
      TEvents,
      TSteps,
      TChildWorkflows,
      TForeignWorkflows,
      TPatches,
      TRng
    >,
    args: StandardSchemaV1.InferOutput<TArgs>,
  ) => Promise<StandardSchemaV1.InferInput<TResultSchema>>;
}): WorkflowDefinition<
  TState,
  TChannels,
  TStreams,
  TEvents,
  TSteps,
  TChildWorkflows,
  TForeignWorkflows,
  TResultSchema,
  TArgs,
  TMetadata,
  TPatches,
  TRng
> {
  // Validate name
  if (!config.name || typeof config.name !== "string") {
    throw new Error("Workflow name must be a non-empty string");
  }

  // Validate state if provided
  if (config.state !== undefined) {
    if (typeof config.state !== "function") {
      throw new Error("state must be a factory function");
    }
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
      throw new Error("retention must be a number or RetentionSettings object");
    }
  }

  // Validate hooks if provided
  if (
    config.beforeCompensate !== undefined &&
    typeof config.beforeCompensate !== "function"
  ) {
    throw new Error("beforeCompensate must be a function");
  }
  if (
    config.afterCompensate !== undefined &&
    typeof config.afterCompensate !== "function"
  ) {
    throw new Error("afterCompensate must be a function");
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
    childWorkflows,
    foreignWorkflows,
    patches,
    rng,
  } as WorkflowDefinition<
    TState,
    TChannels,
    TStreams,
    TEvents,
    TSteps,
    TChildWorkflows,
    TForeignWorkflows,
    TResultSchema,
    TArgs,
    TMetadata,
    TPatches,
    TRng
  >;
}
