import type { Pool } from "pg";
import type {
  WorkflowDefinition,
  WorkflowHandleExternal,
  StartWorkflowOptions,
  InferWorkflowResult,
  InferWorkflowChannels,
  InferWorkflowStreams,
  InferWorkflowEvents,
  InferWorkflowArgsInput,
  WorkflowDefinitions,
  WorkflowResult,
  ExternalWaitOptions,
} from "./types";
import { DatabaseOperations } from "./internal/database";
import { NotificationsManager } from "./internal/notifications";
import { WorkflowExecutor } from "./internal/executor";
import { EngineShutdownError } from "./internal/errors";
import { generateExecutorId } from "./internal/utils";

// =============================================================================
// ENGINE WORKFLOW ACCESSOR
// =============================================================================

/**
 * Accessor for a workflow at engine level.
 * Provides .start(), .execute(), and .get() methods.
 *
 * Engine-level types retain full result unions (`WorkflowResult<T>` with `ok` field)
 * since engine callers need to handle all outcomes. The `WorkflowResult` includes
 * `error: WorkflowExecutionError` on the `"failed"` status for error observability.
 *
 * Engine-level handles (`WorkflowHandleExternal`) retain `sigterm()` and `sigkill()`
 * for operational lifecycle control.
 */
export interface EngineWorkflowAccessor<
  W extends WorkflowDefinition<
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
  >,
> {
  /**
   * Start a new instance of this workflow.
   *
   * @param options - Start options (id, args, seed, timeout, retention).
   * @returns External handle to the workflow.
   *
   * @example
   * ```typescript
   * const handle = await engine.workflows.order.start({
   *   workflowId: 'order-123',
   *   args: { customerId: 'cust-456', items: [...] },
   * });
   * ```
   */
  start(
    options: StartWorkflowOptions<InferWorkflowArgsInput<W>>,
  ): Promise<
    WorkflowHandleExternal<
      InferWorkflowResult<W>,
      InferWorkflowChannels<W>,
      InferWorkflowStreams<W>,
      InferWorkflowEvents<W>
    >
  >;

  /**
   * Start a workflow and wait for it to complete (convenience for
   * start + getResult). Waits indefinitely for the workflow to reach
   * a terminal state.
   *
   * @param options - Start options (id, args, seed, timeout, retention).
   * @returns The workflow result.
   *
   * @example
   * ```typescript
   * const result = await engine.workflows.order.execute({
   *   workflowId: 'order-123',
   *   args: { customerId: 'cust-456', items: [...] },
   * });
   * if (result.ok) {
   *   console.log('Order completed:', result.data);
   * } else if (result.status === 'failed') {
   *   console.error('Order failed:', result.error.message); // WorkflowExecutionError
   * }
   * ```
   */
  execute(
    options: StartWorkflowOptions<InferWorkflowArgsInput<W>>,
  ): Promise<WorkflowResult<InferWorkflowResult<W>>>;

  /**
   * Get a handle to an existing workflow instance.
   *
   * @param workflowId - The workflow instance ID.
   * @returns External handle to the workflow.
   *
   * @example
   * ```typescript
   * const handle = engine.workflows.order.get('order-123');
   * const status = await handle.getStatus();
   * ```
   */
  get(
    workflowId: string,
  ): WorkflowHandleExternal<
    InferWorkflowResult<W>,
    InferWorkflowChannels<W>,
    InferWorkflowStreams<W>,
    InferWorkflowEvents<W>
  >;
}

// =============================================================================
// ENGINE CONFIGURATION
// =============================================================================

/**
 * Configuration for the WorkflowEngine.
 */
export interface WorkflowEngineConfig<
  TWfs extends WorkflowDefinitions = Record<string, never>,
> {
  /** Postgres connection pool */
  pool: Pool;

  /**
   * Registered workflows.
   *
   * Workflows must be registered at construction time for type safety.
   * This creates engine.workflows.{workflowName}.start() and
   * engine.workflows.{workflowName}.get() accessors.
   */
  workflows: TWfs;

  /**
   * Schema name for workflow tables.
   * @default 'workflows'
   */
  schemaName?: string;

  /**
   * Unique identifier for this executor instance.
   * Auto-generated if not provided.
   */
  executorId?: string;

  /**
   * Maximum concurrent workflow executions.
   * @default 10
   */
  maxConcurrentExecutions?: number;

  /**
   * Custom logger.
   * @default console
   */
  logger?: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>) => void;
    debug: (message: string, meta?: Record<string, unknown>) => void;
  };

  /**
   * Garbage collection interval in seconds.
   *
   * - If a positive number: Run GC every N seconds.
   * - If null or undefined: Disable automatic garbage collection.
   *
   * @default 3600 (1 hour)
   */
  gcIntervalSeconds?: number | null;

  /**
   * Polling intervals for notifications fallback.
   */
  polling?: {
    /** Channel message polling interval in ms @default 1000 */
    channelPollIntervalMs?: number;
    /** Event polling interval in ms @default 5000 */
    eventPollIntervalMs?: number;
    /** Workflow status polling interval in ms @default 1000 */
    workflowPollIntervalMs?: number;
  };
}

// =============================================================================
// WORKFLOW ENGINE
// =============================================================================

/**
 * WorkflowEngine — The main entry point for workflow operations.
 *
 * The engine wraps a Postgres pool with workflow execution capabilities.
 * All workflow operations go through the engine.
 *
 * @example
 * ```typescript
 * import { WorkflowEngine } from './engine';
 * import { Pool } from 'pg';
 * import { orderWorkflow, travelBookingWorkflow } from './workflows';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const engine = new WorkflowEngine({
 *   pool,
 *   workflows: {
 *     order: orderWorkflow,
 *     travelBooking: travelBookingWorkflow,
 *   },
 * });
 *
 * await engine.start();
 *
 * const handle = await engine.workflows.order.start({
 *   workflowId: 'order-123',
 *   args: { customerId: 'cust-456', items: [...] },
 * });
 *
 * // Send a message
 * const result = await handle.channels.payment.send({ amount: 100, txnId: 'abc' });
 *
 * // Wait for lifecycle event
 * const completed = await handle.lifecycle.complete.wait({
 *   signal: AbortSignal.timeout(300_000),
 * });
 *
 * // Wait for user-defined event
 * const eventResult = await handle.events.paymentReceived.wait({
 *   signal: AbortSignal.timeout(300_000),
 * });
 *
 * // Get result — engine-level uses full discriminated union
 * const finalResult = await handle.getResult();
 * if (!finalResult.ok && finalResult.status === 'failed') {
 *   console.error(finalResult.error.message); // WorkflowExecutionError
 * }
 *
 * // Signals (engine-level only — not available in workflow code)
 * await handle.sigterm();  // Graceful shutdown with compensation
 * await handle.sigkill();  // Immediate shutdown, no compensation
 *
 * await engine.shutdown();
 * ```
 */
export class WorkflowEngine<
  TWfs extends WorkflowDefinitions = Record<string, never>,
> {
  private readonly db: DatabaseOperations;
  private readonly notifications: NotificationsManager;
  private readonly executor: WorkflowExecutor;
  private readonly config: Required<
    Omit<WorkflowEngineConfig<TWfs>, "pool" | "polling" | "workflows">
  > & {
    pool: Pool;
    polling: NonNullable<WorkflowEngineConfig<TWfs>["polling"]>;
  };

  private gcInterval: NodeJS.Timeout | null = null;
  private isStarted = false;
  private isShutdown = false;

  /**
   * Workflow accessors — populated from constructor.
   * Use engine.workflows.{workflowName}.start() and
   * engine.workflows.{workflowName}.get().
   */
  public readonly workflows: {
    [K in keyof TWfs]: EngineWorkflowAccessor<TWfs[K]>;
  };

  constructor(config: WorkflowEngineConfig<TWfs>) {
    this.config = {
      pool: config.pool,
      schemaName: config.schemaName ?? "workflows",
      executorId: config.executorId ?? generateExecutorId(),
      maxConcurrentExecutions: config.maxConcurrentExecutions ?? 10,
      logger: config.logger ?? console,
      gcIntervalSeconds:
        config.gcIntervalSeconds === undefined
          ? 3600
          : config.gcIntervalSeconds,
      polling: {
        channelPollIntervalMs: config.polling?.channelPollIntervalMs ?? 1000,
        eventPollIntervalMs: config.polling?.eventPollIntervalMs ?? 5000,
        workflowPollIntervalMs: config.polling?.workflowPollIntervalMs ?? 1000,
      },
    };

    this.db = new DatabaseOperations(config.pool, this.config.schemaName);
    this.notifications = new NotificationsManager(
      config.pool,
      this.config.schemaName,
      this.config.polling,
    );
    this.executor = new WorkflowExecutor(
      this.db,
      this.notifications,
      config.pool,
      {
        executorId: this.config.executorId,
        maxConcurrentExecutions: this.config.maxConcurrentExecutions,
        logger: this.config.logger,
      },
    );

    // Register workflows and build accessors
    const workflowAccessors: Record<string, EngineWorkflowAccessor<any>> = {};
    for (const [name, workflowDef] of Object.entries(
      config.workflows as Record<
        string,
        WorkflowDefinition<any, any, any, any, any, any, any, any, any, any>
      >,
    )) {
      // Register with executor for claiming
      this.executor.registerWorkflow(workflowDef);

      // Create type-safe accessor
      workflowAccessors[name] = {
        start: async (options: any) => {
          this.assertNotShutdown();
          return this.executor.startWorkflow(workflowDef, options);
        },
        execute: async (options: any) => {
          this.assertNotShutdown();
          const handle = await this.executor.startWorkflow(
            workflowDef,
            options,
          );
          return handle.getResult();
        },
        get: (workflowId: string) => {
          this.assertNotShutdown();
          return this.executor.getWorkflowHandle(workflowDef, workflowId);
        },
      };
    }
    this.workflows = workflowAccessors as any;
  }

  /**
   * Start the engine.
   *
   * Begins:
   * - Listening for PostgreSQL notifications
   * - Background worker loop to claim and execute workflows
   * - Recovery of any workflows that were running on this executor
   * - Garbage collection (if configured)
   */
  async start(): Promise<void> {
    if (this.isShutdown) {
      throw new EngineShutdownError();
    }
    if (this.isStarted) {
      return;
    }

    this.config.logger.info("Starting WorkflowEngine", {
      executorId: this.executor.executorId,
      schemaName: this.config.schemaName,
    });

    // Start notification listener
    await this.notifications.start();

    // Recover pending workflows
    await this.executor.recoverPendingWorkflows();

    // Start GC loop if configured
    if (this.config.gcIntervalSeconds && this.config.gcIntervalSeconds > 0) {
      this.startGarbageCollection();
    }

    // Start worker loop
    this.executor.startWorkerLoop();

    this.isStarted = true;
    this.config.logger.info("WorkflowEngine started");
  }

  /**
   * Manually trigger garbage collection.
   *
   * @param batchSize - Number of workflows to delete per batch.
   * @returns Number of workflows deleted.
   */
  async runGarbageCollection(batchSize = 100): Promise<number> {
    this.assertNotShutdown();

    let totalDeleted = 0;
    let deleted: number;

    do {
      deleted = await this.db.deleteExpiredWorkflows(batchSize);
      totalDeleted += deleted;
    } while (deleted === batchSize);

    if (totalDeleted > 0) {
      this.config.logger.info("Garbage collection completed", {
        deleted: totalDeleted,
      });
    }

    return totalDeleted;
  }

  /**
   * Shutdown the engine gracefully.
   *
   * Stops accepting new work, waits for running workflows to drain, and
   * shuts down the notification listener. Pass an AbortSignal to control
   * the maximum wait time for in-flight workflows.
   *
   * @param options - Optional wait options with AbortSignal.
   *
   * @example
   * ```typescript
   * // Wait up to 30 seconds for running workflows to drain
   * await engine.shutdown({ signal: AbortSignal.timeout(30_000) });
   *
   * // Wait indefinitely
   * await engine.shutdown();
   * ```
   */
  async shutdown(options?: ExternalWaitOptions): Promise<void> {
    if (this.isShutdown) {
      return;
    }

    this.isShutdown = true;
    this.config.logger.info("Shutting down WorkflowEngine...");

    // Stop accepting new work
    this.executor.shutdown();

    // Stop GC
    if (this.gcInterval) {
      clearInterval(this.gcInterval);
      this.gcInterval = null;
    }

    // Wait for running workflows to complete
    // @ts-expect-error internal API out of sync — will be updated to accept AbortSignal
    await this.executor.drainRunningWorkflows(options?.signal);

    // Stop notification listener
    await this.notifications.stop();

    this.config.logger.info("WorkflowEngine shutdown complete");
  }

  /**
   * Get the executor ID for this engine instance.
   */
  get executorId(): string {
    return this.executor.executorId;
  }

  private assertNotShutdown(): void {
    if (this.isShutdown) {
      throw new EngineShutdownError();
    }
  }

  private startGarbageCollection(): void {
    const intervalMs = this.config.gcIntervalSeconds! * 1000;

    this.gcInterval = setInterval(async () => {
      try {
        await this.runGarbageCollection();
      } catch (err) {
        this.config.logger.error("Garbage collection failed", { error: err });
      }
    }, intervalMs);

    // Don't prevent process exit
    this.gcInterval.unref();
  }
}
