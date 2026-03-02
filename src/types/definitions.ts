import type { StandardSchemaV1 } from "./standard-schema";
import type { CompensationContext, WorkflowContext } from "./context";
import type { DeterministicAwaitable } from "./concurrency";

// =============================================================================
// SCHEMA DEFINITIONS
// =============================================================================

/**
 * Channel definitions map - keys are channel names, values are standard schemas.
 * Channels are for async message passing between workflows.
 */
export type ChannelDefinitions = Record<
  string,
  StandardSchemaV1<unknown, unknown>
>;

/**
 * Stream definitions map - keys are stream names, values are standard schemas.
 * Streams are append-only logs for external consumption.
 */
export type StreamDefinitions = Record<
  string,
  StandardSchemaV1<unknown, unknown>
>;

/**
 * Event definitions - keys are event names, values are `true`.
 * Events are value-less write-once flags for coordination.
 */
export type EventDefinitions = Record<string, true>;

/**
 * Patch definitions — keys are patch names, values indicate active status.
 *
 * - `true`: The patch is active — new workflows will execute the patched code path.
 * - `false`: The patch is deprecated — new workflows will NOT execute the patched code path,
 *   but old (replaying) workflows that already entered it will still run it.
 *
 * Patches enable safe, incremental evolution of workflow code without breaking
 * in-flight workflows.
 */
export type PatchDefinitions = Record<string, boolean>;

/**
 * RNG definitions — keys are RNG stream names, values are either:
 *
 * - `true`: A simple named RNG stream. Accessed as `ctx.rng.name` (a `DeterministicRNG` instance).
 * - A key derivation function: A parametrized RNG stream. Accessed as `ctx.rng.name(...args)`
 *   which returns a `DeterministicRNG` instance. The function receives the parameters and
 *   returns a string key that the engine uses (prefixed with the definition name) to seed
 *   the RNG. Must be pure and deterministic — same arguments must always produce the same key.
 *
 * @example
 * ```typescript
 * rng: {
 *   txnId: true,                                               // simple
 *   itemsShuffle: (category: string) => `items:${category}`,   // parametrized
 * }
 * // ctx.rng.txnId.uuidv4()
 * // ctx.rng.itemsShuffle('electronics').shuffle(products)
 * ```
 */
export type RngDefinitions = Record<
  string,
  true | ((...args: any[]) => string)
>;

/**
 * Accessor for a single patch on ctx.patches.
 *
 * Supports two usage patterns:
 *
 * **Boolean form** — await the accessor directly to get true/false.
 * Use for removing code or complex restructuring:
 * ```typescript
 * if (!await ctx.patches.removeLegacyEmail) {
 *   await ctx.steps.sendLegacyEmail(...);
 * }
 * ```
 *
 * **Callback form** — runs the callback if active, returns default otherwise.
 * Use for adding new code paths (90% of the time):
 * ```typescript
 * const result = await ctx.patches.antifraud(async () => {
 *   return await ctx.steps.fraudCheck(flightId);
 * }, null);
 * ```
 */
export interface PatchAccessor extends DeterministicAwaitable<boolean> {
  /** Boolean form — await the accessor directly for active/inactive */
  then<R1 = boolean>(
    onfulfilled?:
      | ((value: boolean) => R1 | PromiseLike<R1>)
      | null
      | undefined,
  ): DeterministicAwaitable<R1>;
  /** Callback form with default — runs callback if active, returns default otherwise */
  <T, D>(
    callback: () => Promise<T> | DeterministicAwaitable<T>,
    defaultValue: D,
  ): DeterministicAwaitable<T | D>;
  /** Callback form without default — runs callback if active, returns undefined otherwise */
  <T>(
    callback: () => Promise<T> | DeterministicAwaitable<T>,
  ): DeterministicAwaitable<T | undefined>;
}

// =============================================================================
// RETRY POLICY
// =============================================================================

/**
 * Configuration for retry behavior and timeouts.
 */
export interface RetryPolicyBaseOptions {
  /** Maximum retry attempts (default: unlimited) */
  maxAttempts?: number;
  /** Initial retry interval in seconds (default: 1) */
  intervalSeconds?: number;
  /** Backoff multiplier (default: 2) */
  backoffRate?: number;
  /** Maximum retry interval cap in seconds (default: 300) */
  maxIntervalSeconds?: number;
  /** Per-attempt timeout in seconds (default: no timeout) */
  timeoutSeconds?: number;
}

/**
 * Mutually exclusive deadline options.
 * Provide at most one of `deadlineSeconds` or `deadlineUntil`.
 */
export type DeadlineOptions =
  | { deadlineSeconds: number; deadlineUntil?: never }
  | { deadlineUntil: Date | number; deadlineSeconds?: never }
  | { deadlineSeconds?: undefined; deadlineUntil?: undefined };

/**
 * Retry policy with optional total deadline.
 */
export type RetryPolicyOptions = RetryPolicyBaseOptions & DeadlineOptions;

// =============================================================================
// STEP DEFINITION
// =============================================================================

/**
 * Step definition - created via defineStep().
 *
 * Steps are durable, idempotent operations executed outside the workflow.
 *
 * Use your own application logger (console.log, Winston, Pino, etc.) inside
 * step implementations — workflow-level logging is separate via ctx.logger.
 */
export interface StepDefinition<
  TArgs extends unknown[] = unknown[],
  TResultSchema extends StandardSchemaV1<unknown, unknown> = any,
> {
  readonly name: string;
  /**
   * Execute function — must return z.input<schema>.
   * Use your own application logger for step-level logging.
   */
  readonly execute: (
    context: { signal: AbortSignal },
    ...args: TArgs
  ) => Promise<StandardSchemaV1.InferInput<TResultSchema>>;
  /** Result schema for encoding/decoding */
  readonly schema: TResultSchema;
  /** Default retry policy */
  readonly retryPolicy?: RetryPolicyOptions;
}

/**
 * Map of step definitions.
 */
export type StepDefinitions = Record<string, StepDefinition<any[], any>>;

/**
 * Map of workflow definitions for child/foreign workflow references.
 * Accepts both full `WorkflowDefinition` objects and lightweight
 * `WorkflowHeader` descriptors — `WorkflowDefinition` satisfies
 * `AnyWorkflowHeader` structurally so the two are interchangeable here.
 */
export type WorkflowDefinitions = Record<string, AnyWorkflowHeader>;

/**
 * Any workflow definition shape.
 * Useful for avoiding repeated `WorkflowDefinition<any, ...>` constraints.
 */
export type AnyWorkflowDefinition = WorkflowDefinition<
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

/**
 * Public workflow descriptor for external/client-facing APIs.
 *
 * Captures the contract clients need to interact with workflow instances:
 * - identity (`name`)
 * - start contract (`args`, `metadata`)
 * - interaction surface (`channels`, `streams`, `events`)
 * - terminal payload contract (`result`)
 *
 * This type intentionally excludes implementation details (`execute`, `steps`,
 * `state`, `rng`, hooks, etc.). Full `WorkflowDefinition` objects satisfy this
 * shape structurally and can be used where only client contracts are needed.
 */
export interface PublicWorkflowHeader<
  TChannels extends ChannelDefinitions = Record<string, never>,
  TStreams extends StreamDefinitions = Record<string, never>,
  TEvents extends EventDefinitions = Record<string, never>,
  TArgs extends StandardSchemaV1<unknown, unknown> = StandardSchemaV1<
    void,
    void
  >,
  TMetadata extends StandardSchemaV1<unknown, unknown> = StandardSchemaV1<
    void,
    void
  >,
  TResult extends StandardSchemaV1<unknown, unknown> = StandardSchemaV1<
    void,
    void
  >,
> {
  readonly name: string;
  readonly channels?: TChannels;
  readonly streams?: TStreams;
  readonly events?: TEvents;
  readonly args?: TArgs;
  readonly metadata?: TMetadata;
  readonly result?: TResult;
}

/**
 * Any public workflow descriptor shape.
 */
export type AnyPublicWorkflowHeader = PublicWorkflowHeader<
  any,
  any,
  any,
  any,
  any,
  any
>;

/**
 * Minimal workflow descriptor used by workflow authoring to break circular
 * dependencies between workflow modules.
 *
 * Use `defineWorkflowHeader()` to create one. Then:
 *
 * - Spread into `defineWorkflow({ ...header, ... })` so the full definition
 *   inherits the same name and schema declarations — single source of truth.
 * - Pass directly to `foreignWorkflows` or `childWorkflows` in any workflow
 *   that needs to reference this one.
 *
 * This resolves circular references cleanly: define the header first, use it
 * in both directions, then fill in the implementations afterward.
 *
 * ```typescript
 * const managerHeader = defineWorkflowHeader({
 *   name: "scheduler",
 *   channels: { done: DonePayload },
 * });
 *
 * // worker references manager via header — no circular dep
 * const workerWorkflow = defineWorkflow({
 *   ...workerHeader,
 *   foreignWorkflows: { manager: managerHeader },
 *   execute: async (ctx, args) => { ... },
 * });
 *
 * // manager spreads its own header + adds full implementation
 * const managerWorkflow = defineWorkflow({
 *   ...managerHeader,
 *   childWorkflows: { worker: workerWorkflow },
 *   execute: async (ctx, args) => { ... },
 * });
 * ```
 *
 * A workflow can also reference itself (recursive/fractal workflows):
 * ```typescript
 * const treeHeader = defineWorkflowHeader({ name: "tree", args: TreeArgs });
 * const treeWorkflow = defineWorkflow({
 *   ...treeHeader,
 *   childWorkflows: { node: treeHeader },
 *   execute: async (ctx, args) => { ... },
 * });
 * ```
 */
export interface WorkflowHeader<
  TChannels extends ChannelDefinitions = Record<string, never>,
  TArgs extends StandardSchemaV1<unknown, unknown> = StandardSchemaV1<
    void,
    void
  >,
  TMetadata extends StandardSchemaV1<unknown, unknown> = StandardSchemaV1<
    void,
    void
  >,
  TResult extends StandardSchemaV1<unknown, unknown> = StandardSchemaV1<
    void,
    void
  >,
> {
  readonly name: string;
  readonly channels?: TChannels;
  readonly args?: TArgs;
  readonly metadata?: TMetadata;
  readonly result?: TResult;
}

/**
 * Any workflow header shape.
 * Used as the constraint for `childWorkflows` and `foreignWorkflows` entries —
 * both full `WorkflowDefinition` objects and lightweight `WorkflowHeader`
 * descriptors satisfy this type.
 */
export type AnyWorkflowHeader = WorkflowHeader<any, any, any, any>;

// =============================================================================
// DETERMINISTIC RNG
// =============================================================================

/**
 * Deterministic random utilities for use inside workflows.
 * Accessed through typed RNG accessors on the workflow context.
 */
export interface DeterministicRNG {
  /** Generate a deterministic UUID */
  uuidv4(): string;
  /** Generate a deterministic integer in range [min, max] */
  int(minInclusive?: number, maxInclusive?: number): number;
  /** Generate a deterministic float in range [0, 1) */
  next(): number;
  /** boolean with p = 0.5 */
  bool(): boolean;
  /** boolean with custom probability */
  chance(probability: number): boolean;
  /** Generate a deterministic string of length n */
  string(options: { length: number; alphabet?: string }): string;
  /** Pick a random element from an array */
  pick<T>(array: readonly T[]): T;
  /** Pick a random element from an array with weights */
  weightedPick<T>(items: readonly { value: T; weight: number }[]): T;
  /** Shuffle an array */
  shuffle<T>(array: readonly T[]): T[];
  /** Sample count elements from an array */
  sample<T>(array: readonly T[], count: number): T[];
  /** Sample count elements from an array with weights */
  weightedSample<T>(
    items: readonly { value: T; weight: number }[],
    count: number,
  ): T[];
  /** Generate a deterministic bytes array */
  bytes(length: number): Uint8Array;
}

/**
 * Map RNG definitions to their runtime accessor types.
 *
 * - `true` entries become `DeterministicRNG` instances (direct access).
 * - Function entries become functions with the same signature that return `DeterministicRNG`.
 */
export type RngAccessors<TRng extends RngDefinitions> = {
  [K in keyof TRng]: TRng[K] extends true
    ? DeterministicRNG
    : TRng[K] extends (...args: infer A) => string
      ? (...args: A) => DeterministicRNG
      : never;
};

/**
 * Base invocation options for workflow starts/calls.
 */
export type WorkflowInvocationBaseOptions<TArgsInput, TMetadataInput> = {
  /**
   * Optional idempotency key for workflow identity.
   * If omitted, the engine generates a unique key.
   */
  idempotencyKey?: string;
  args?: TArgsInput;
  /** Optional immutable metadata for this workflow instance. */
  metadata?: TMetadataInput;
  /** Optional deterministic RNG seed override for the child workflow instance. */
  seed?: string;
};

// =============================================================================
// RETENTION
// =============================================================================

/**
 * Retention settings for workflow garbage collection.
 * Specifies how long workflows should be kept in the database after reaching
 * terminal states. All durations are in seconds. null means never delete.
 */
export interface RetentionSettings {
  /** Retention period for completed workflows (seconds) */
  readonly complete: number | null;
  /** Retention period for failed workflows (seconds) */
  readonly failed: number | null;
  /** Retention period for terminated workflows (seconds) */
  readonly terminated: number | null;
}

// =============================================================================
// STATE FACTORY
// =============================================================================

/**
 * State factory type for a workflow.
 *
 * Provides the initial state for each workflow instance.
 * State is NOT persisted to the database — it is derived from replay.
 */
export type StateFactory<TState> = () => TState;

// =============================================================================
// WORKFLOW DEFINITION
// =============================================================================

/**
 * Workflow definition — the blueprint for workflow instances.
 *
 * Workflows are durable, long-running processes that survive restarts via replay.
 * They communicate via channels, output data via streams, signal milestones via
 * events, and execute durable operations via steps.
 *
 * **Callable thenable model:** Steps and child workflows are called directly and
 * return thenables (`StepCall<T>`, `WorkflowCall<T>`) that can be awaited
 * immediately or chained with builder methods before awaiting.
 *
 * **Compensation:** Register per-step/workflow via `.compensate(cb)` builder.
 * `addCompensation(cb)` provides general-purpose cleanup. Runs LIFO on failure.
 *
 * **Structured concurrency:** All concurrent branches run as closures inside
 * `ctx.scope(name, ...)`. Collections (Array, Map) are supported for dynamic fan-out.
 */
export interface WorkflowDefinition<
  TState,
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TSteps extends StepDefinitions,
  TChildWorkflows extends WorkflowDefinitions,
  TForeignWorkflows extends WorkflowDefinitions,
  TResultSchema extends StandardSchemaV1<unknown, unknown> = StandardSchemaV1<
    void,
    void
  >,
  TArgs extends StandardSchemaV1<unknown, unknown> = StandardSchemaV1<
    void,
    void
  >,
  TMetadata extends StandardSchemaV1<unknown, unknown> = StandardSchemaV1<
    void,
    void
  >,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
> extends PublicWorkflowHeader<
    TChannels,
    TStreams,
    TEvents,
    TArgs,
    TMetadata,
    TResultSchema
  > {
  /** Unique workflow name */
  readonly name: string;

  /** State factory — provides initial state for each workflow instance */
  readonly state?: StateFactory<TState>;

  /** Channel definitions */
  readonly channels?: TChannels;

  /** Stream definitions */
  readonly streams?: TStreams;

  /** Event definitions */
  readonly events?: TEvents;

  /** Step definitions */
  readonly steps?: TSteps;

  /** Child workflow definitions (for ctx.childWorkflows) */
  readonly childWorkflows?: TChildWorkflows;

  /** Foreign workflow definitions (for ctx.foreignWorkflows) */
  readonly foreignWorkflows?: TForeignWorkflows;

  /**
   * Patch definitions for safe workflow evolution.
   *
   * - `true`: Active — new workflows will execute the patched code path.
   * - `false`: Deprecated — new workflows skip the patch, but replaying workflows
   *   that already entered it will still run it.
   */
  readonly patches?: TPatches;

  /**
   * RNG definitions for deterministic randomness.
   *
   * - `true`: Simple named RNG stream — accessed as `ctx.rng.name`.
   * - Function: Parametrized RNG stream — accessed as `ctx.rng.name(...args)`.
   */
  readonly rng?: TRng;

  /** Result schema for encoding/decoding workflow result */
  readonly result?: TResultSchema;

  /** Arguments schema (optional) */
  readonly args?: TArgs;

  /**
   * Optional immutable metadata schema for workflow instances.
   * Metadata is provided at start time and persisted for audit/filtering.
   */
  readonly metadata?: TMetadata;

  /**
   * Workflow retention policy for garbage collection.
   *
   * - If a number: Same retention for all terminal states (seconds).
   * - If RetentionSettings: Different retention per terminal state (seconds).
   * - If undefined: Workflows are never garbage collected.
   */
  readonly retention?: number | RetentionSettings;

  /**
   * Called before compensations run.
   * Receives CompensationContext — has full structured concurrency capabilities.
   */
  readonly beforeCompensate?: (params: {
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

  /**
   * Called after all compensations have run.
   * Receives CompensationContext — has full structured concurrency capabilities.
   */
  readonly afterCompensate?: (params: {
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

  /**
   * Called once before final workflow status is settled.
   *
   * - `complete`: receives WorkflowContext + decoded result.
   * - `failed` / `terminated`: receives CompensationContext.
   *
   * If this hook throws on the complete path, the workflow transitions into
   * failure flow (`beforeCompensate` -> LIFO compensations -> `afterCompensate`).
   * The hook is single-shot and is not invoked a second time.
   */
  readonly beforeSettle?: (params:
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

  /**
   * Workflow execution function.
   * Must return z.input<ResultSchema> (encoded for DB).
   * Throwing an exception fails the workflow and triggers compensation.
   */
  execute(
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
  ): Promise<StandardSchemaV1.InferInput<TResultSchema>>;
}
