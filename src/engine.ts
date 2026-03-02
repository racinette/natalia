import type { Pool } from "pg";
import type { AnyWorkflowDefinition, ExternalWaitOptions } from "./types";
import { EngineShutdownError } from "./internal/errors";
import { ScopeRuntimeRegistry } from "./internal/scope-runtime-registry";
import { AbstractWorkflowClient } from "./client";

// =============================================================================
// ENGINE CONFIGURATION
// =============================================================================

/**
 * Configuration for the WorkflowEngine.
 */
export interface WorkflowEngineConfig<
  TWfs extends Record<string, AnyWorkflowDefinition> = Record<string, never>,
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
 *   idempotencyKey: 'order-123',
 *   metadata: { tenantId: 'tenant-acme', correlationId: 'req-42' },
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
  TWfs extends Record<string, AnyWorkflowDefinition> = Record<string, never>,
> extends AbstractWorkflowClient<TWfs> {
  private readonly config: WorkflowEngineConfig<TWfs>;
  private gcInterval: NodeJS.Timeout | null = null;
  private isStarted = false;
  private isShutdown = false;
  /**
   * Named-scope runtime guard.
   * Will be consumed by the scope executor implementation to reject duplicate
   * active child scope names under the same parent path.
   */
  private readonly scopeRuntimeRegistry = new ScopeRuntimeRegistry();

  constructor(config: WorkflowEngineConfig<TWfs>) {
    super(config.workflows);
    this.config = config;
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

    if (this.config.gcIntervalSeconds && this.config.gcIntervalSeconds > 0) {
      this.startGarbageCollection();
    }

    this.isStarted = true;
  }

  /**
   * Manually trigger garbage collection.
   *
   * @param batchSize - Number of workflows to delete per batch.
   * @returns Number of workflows deleted.
   */
  async runGarbageCollection(_batchSize = 100): Promise<number> {
    this.assertNotShutdown();
    throw new Error("Not implemented");
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
  async shutdown(_options?: ExternalWaitOptions): Promise<void> {
    if (this.isShutdown) {
      return;
    }
    this.isShutdown = true;

    if (this.gcInterval) {
      clearInterval(this.gcInterval);
      this.gcInterval = null;
    }
  }

  /**
   * Get the executor ID for this engine instance.
   */
  get executorId(): string {
    return this.config.executorId ?? "not-started";
  }

  private assertNotShutdown(): void {
    if (this.isShutdown) {
      throw new EngineShutdownError();
    }
  }

  protected assertClientAvailable(): void {
    this.assertNotShutdown();
  }

  private startGarbageCollection(): void {
    const intervalMs = this.config.gcIntervalSeconds! * 1000;

    this.gcInterval = setInterval(async () => {
      try {
        await this.runGarbageCollection();
      } catch (err) {
        this.config.logger?.error("Garbage collection failed", { error: err });
      }
    }, intervalMs);

    // Don't prevent process exit
    this.gcInterval.unref();
  }
}
