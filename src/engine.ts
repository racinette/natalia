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
   * Default passivation threshold for workflow instances that do not specify
   * their own `evictAfterSeconds`.
   *
   * When a workflow is suspended (sleeping, awaiting a step, child workflow,
   * or channel), the engine may evict it from memory once it has been idle for
   * at least this many seconds, then replay it when the awaited operation
   * resolves.
   *
   * - If a positive number: use as the engine-wide default idle threshold.
   * - If `null`: never evict by default (all workflows stay resident unless
   *   they individually opt in via `evictAfterSeconds`).
   * - If `undefined`: same as `null` — no eviction unless the workflow definition
   *   explicitly sets `evictAfterSeconds`.
   *
   * @default undefined (no eviction)
   */
  defaultEvictAfterSeconds?: number | null;

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
 * WorkflowEngine — the main entry point for workflow operations.
 *
 * Wraps a Postgres pool with workflow execution capabilities. All workflow
 * operations go through the engine; the engine extends `AbstractWorkflowClient`
 * so `engine.workflows.<name>` exposes the standard client surface
 * (`start` / `execute` / `get` / `findUnique` / `findMany` / `count`) per
 * `REFACTOR.MD` Part 5.
 *
 * @example
 * ```typescript
 * import { WorkflowEngine } from './engine';
 * import { Pool } from 'pg';
 * import { orderWorkflow } from './workflows';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const engine = new WorkflowEngine({
 *   pool,
 *   workflows: { order: orderWorkflow },
 * });
 *
 * await engine.start();
 *
 * // One-shot start + wait via execute(...).
 * const result = await engine.workflows.order.execute({
 *   idempotencyKey: 'order-123',
 *   args: { customerId: 'cust-456' },
 * });
 *
 * // Or start and observe the typed handle.
 * const handle = await engine.workflows.order.start({
 *   idempotencyKey: 'order-456',
 *   args: { customerId: 'cust-789' },
 * });
 * await handle.channels.payment.send({ amount: 100, txnId: 'abc' });
 * const terminal = await handle.wait({ signal: AbortSignal.timeout(300_000) });
 *
 * // Operator-action verbs (REFACTOR.MD Part 3).
 * await handle.sigterm();
 * await handle.sigkill();
 * await handle.skip({ orderId: '...' }, { strategy: 'sigterm' });
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
