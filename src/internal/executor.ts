import type { Pool } from 'pg';
import type { z } from 'zod';
import type {
  WorkflowDefinition,
  WorkflowHandleExternal,
  StartWorkflowOptions,
  RetentionSettings,
  CancellationReason,
} from '../types';
import type { DatabaseOperations, WorkflowRow } from './database';
import type { NotificationsManager } from './notifications';
import { WorkflowContextImpl, type CompensationEntry } from './context';
import {
  WorkflowCancelledError,
  WorkflowKilledError,
  type CancellationReasonInternal,
} from './errors';
import { serializeError } from './serialization';
import { generateExecutorId, sleep, mergeRetryOptions, calculateBackoffMs } from './utils';

// =============================================================================
// TYPES
// =============================================================================

interface RunningWorkflow {
  context: WorkflowContextImpl<any, any, any, any, any, any>;
  abortController: AbortController;
  cancellationRequested: CancellationReasonInternal | null;
  killRequested: boolean;
}

interface ExecutorConfig {
  executorId?: string;
  maxConcurrentExecutions: number;
  logger: {
    info: (msg: string, data?: Record<string, unknown>) => void;
    warn: (msg: string, data?: Record<string, unknown>) => void;
    error: (msg: string, data?: Record<string, unknown>) => void;
    debug: (msg: string, data?: Record<string, unknown>) => void;
  };
}

// =============================================================================
// WORKFLOW EXECUTOR
// =============================================================================

export class WorkflowExecutor {
  readonly executorId: string;
  private readonly runningWorkflows = new Map<string, RunningWorkflow>();
  private readonly workflowDefinitions = new Map<string, WorkflowDefinition<any, any, any, any, any, any, any, any, any, any>>();
  private isShuttingDown = false;
  private workerLoopRunning = false;
  private workerLoopPromise: Promise<void> | null = null;

  constructor(
    private readonly db: DatabaseOperations,
    private readonly notifications: NotificationsManager,
    private readonly pool: Pool,
    private readonly config: ExecutorConfig,
  ) {
    this.executorId = config.executorId ?? generateExecutorId();
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  /**
   * Register a workflow definition
   */
  registerWorkflow(workflow: WorkflowDefinition<any, any, any, any, any, any, any, any, any, any>): void {
    this.workflowDefinitions.set(workflow.name, workflow);
  }

  /**
   * Start a new workflow
   */
  async startWorkflow<W extends WorkflowDefinition<any, any, any, any, any, any, any, any, any, any>>(
    workflow: W,
    options: StartWorkflowOptions<any, any, any>,
  ): Promise<WorkflowHandleExternal<any, any, any, any, any, any>> {
    // Register workflow definition
    this.registerWorkflow(workflow);

    // Encode args if schema provided
    const encodedArgs = workflow.argSchema && options.args != null
      ? encodeWithSchema(workflow.argSchema, options.args)
      : options.args;

    // Calculate retention deadlines
    const retention = this.calculateRetention(options.retention ?? workflow.retention);

    // Create workflow record
    await this.db.createWorkflow({
      id: options.workflowId,
      name: workflow.name,
      arguments: encodedArgs,
      deadlineAt: options.timeoutSeconds
        ? new Date(Date.now() + options.timeoutSeconds * 1000)
        : undefined,
      ...retention,
    });

    // Create and return handle
    return this.createExternalHandle(workflow, options.workflowId);
  }

  /**
   * Get a handle to an existing workflow
   */
  getWorkflowHandle<W extends WorkflowDefinition<any, any, any, any, any, any, any, any, any, any>>(
    workflow: W,
    workflowId: string,
  ): WorkflowHandleExternal<any, any, any, any, any, any> {
    this.registerWorkflow(workflow);
    return this.createExternalHandle(workflow, workflowId);
  }

  /**
   * Get a running workflow by ID (for queries)
   */
  getRunningWorkflow(workflowId: string): RunningWorkflow | undefined {
    return this.runningWorkflows.get(workflowId);
  }

  /**
   * Start the background worker loop
   */
  startWorkerLoop(): void {
    if (this.workerLoopRunning || this.isShuttingDown) return;

    this.workerLoopRunning = true;
    this.workerLoopPromise = this.runWorkerLoop();
  }

  /**
   * Stop the background worker loop
   */
  stopWorkerLoop(): void {
    this.workerLoopRunning = false;
  }

  /**
   * Recover workflows that were running on this executor
   */
  async recoverPendingWorkflows(): Promise<void> {
    const workflows = await this.db.getWorkflowsForRecovery(this.executorId);

    this.config.logger.info('Recovering workflows', {
      count: workflows.length,
      executorId: this.executorId,
    });

    for (const workflow of workflows) {
      const definition = this.workflowDefinitions.get(workflow.name);
      if (!definition) {
        this.config.logger.warn('Unknown workflow type, skipping recovery', {
          workflowId: workflow.id,
          name: workflow.name,
        });
        continue;
      }

      // Start recovery in background
      this.executeWorkflow(workflow.id, definition).catch((err) => {
        this.config.logger.error('Workflow recovery failed', {
          workflowId: workflow.id,
          error: err,
        });
      });
    }
  }

  /**
   * Request cancellation of a workflow
   */
  async requestCancellation(
    workflowId: string,
    reason: CancellationReasonInternal,
  ): Promise<{ ok: true; status: 'cancelled' } | { ok: false; status: 'already_finished' | 'not_found' }> {
    // Check if workflow exists
    const workflow = await this.db.getWorkflow(workflowId);
    if (!workflow) {
      return { ok: false, status: 'not_found' };
    }

    // Check if already in terminal state
    if (['complete', 'failed', 'cancelled', 'killed'].includes(workflow.status)) {
      return { ok: false, status: 'already_finished' };
    }

    // Start cancellation in DB
    const reasonType = reason.type === 'external' ? 'external' :
      reason.type === 'timeout' ? 'timeout' : 'parent_cancelled';
    const started = await this.db.startCancellation(workflowId, reasonType);
    if (!started) {
      return { ok: false, status: 'already_finished' };
    }

    // If running locally, signal the workflow
    const running = this.runningWorkflows.get(workflowId);
    if (running) {
      running.cancellationRequested = reason;
    }

    return { ok: true, status: 'cancelled' };
  }

  /**
   * Request immediate kill of a workflow
   */
  async requestKill(
    workflowId: string,
  ): Promise<{ ok: true; status: 'killed' } | { ok: false; status: 'already_finished' | 'not_found' }> {
    const workflow = await this.db.getWorkflow(workflowId);
    if (!workflow) {
      return { ok: false, status: 'not_found' };
    }

    if (['complete', 'failed', 'cancelled', 'killed'].includes(workflow.status)) {
      return { ok: false, status: 'already_finished' };
    }

    const killed = await this.db.killWorkflow(workflowId);
    if (!killed) {
      return { ok: false, status: 'already_finished' };
    }

    // If running locally, signal the workflow
    const running = this.runningWorkflows.get(workflowId);
    if (running) {
      running.killRequested = true;
      running.abortController.abort();
    }

    return { ok: true, status: 'killed' };
  }

  /**
   * Drain running workflows (for shutdown)
   */
  async drainRunningWorkflows(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (this.runningWorkflows.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.config.logger.warn('Timeout draining workflows', {
          remaining: this.runningWorkflows.size,
        });
        break;
      }

      await sleep(Math.min(100, remaining));
    }
  }

  /**
   * Check if shutting down
   */
  get shuttingDown(): boolean {
    return this.isShuttingDown;
  }

  /**
   * Initiate shutdown
   */
  shutdown(): void {
    this.isShuttingDown = true;
    this.stopWorkerLoop();
  }

  // ===========================================================================
  // WORKER LOOP
  // ===========================================================================

  private async runWorkerLoop(): Promise<void> {
    while (this.workerLoopRunning && !this.isShuttingDown) {
      // Check if we can accept more work
      if (this.runningWorkflows.size >= this.config.maxConcurrentExecutions) {
        await sleep(100);
        continue;
      }

      // Try to claim a pending workflow
      const workflow = await this.db.claimPendingWorkflow(this.executorId);

      if (workflow) {
        const definition = this.workflowDefinitions.get(workflow.name);
        if (definition) {
          // Start execution in background
          this.executeWorkflow(workflow.id, definition).catch((err) => {
            this.config.logger.error('Workflow execution failed', {
              workflowId: workflow.id,
              error: err,
            });
          });
        } else {
          this.config.logger.warn('Unknown workflow type', {
            workflowId: workflow.id,
            name: workflow.name,
          });
          // Release the workflow by failing it
          await this.db.failWorkflow(workflow.id, { message: 'Unknown workflow type' });
        }
      } else {
        // No work available - wait for notification or poll timeout
        await this.notifications.waitForAny('workflow_pending', 1000);
      }
    }
  }

  // ===========================================================================
  // WORKFLOW EXECUTION
  // ===========================================================================

  private async executeWorkflow(
    workflowId: string,
    workflowDef: WorkflowDefinition<any, any, any, any, any, any, any, any, any, any>,
  ): Promise<void> {
    // Load workflow data
    const workflowData = await this.db.getWorkflow(workflowId);
    if (!workflowData) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    // Decode args
    const args = workflowDef.argSchema && workflowData.arguments
      ? decodeWithSchema(workflowDef.argSchema, workflowData.arguments)
      : workflowData.arguments;

    // Load existing step executions for replay
    const stepExecutions = await this.db.getStepExecutions(workflowId);

    // Initialize state
    let initialState: unknown;
    if (workflowDef.state?.factory) {
      initialState = workflowDef.state.factory();
      if (workflowDef.state.schema) {
        initialState = decodeWithSchema(workflowDef.state.schema, initialState);
      }
    }

    // Create running workflow tracking
    const running: RunningWorkflow = {
      context: null as any, // Will be set below
      abortController: new AbortController(),
      cancellationRequested: workflowData.status === 'cancelling'
        ? { type: workflowData.cancellation_reason as any, data: undefined }
        : null,
      killRequested: false,
    };

    // Create context
    const context = new WorkflowContextImpl({
      workflowId,
      workflowDef,
      db: this.db,
      notifications: this.notifications,
      pool: this.pool,
      executorId: this.executorId,
      seed: workflowData.seed,
      createdAt: workflowData.created_at,
      initialState,
      stepExecutions,
      onCancellationRequested: () => running.cancellationRequested,
      onKillRequested: () => running.killRequested,
    });

    running.context = context;

    // Track as running
    this.runningWorkflows.set(workflowId, running);

    try {
      // Execute workflow function
      const result = await workflowDef.execute(context, args);

      // Encode and store result
      const encodedResult = workflowDef.result?.schema
        ? encodeWithSchema(workflowDef.result.schema, result)
        : result;

      await this.db.completeWorkflow(workflowId, encodedResult);

      this.config.logger.info('Workflow completed', { workflowId });

    } catch (err) {
      if (err instanceof WorkflowCancelledError) {
        await this.handleCancellation(workflowId, workflowDef, context, args, err.reason);
      } else if (err instanceof WorkflowKilledError) {
        // Already killed in DB, nothing to do
        this.config.logger.info('Workflow killed', { workflowId });
      } else {
        const serialized = serializeError(err);
        await this.db.failWorkflow(workflowId, serialized);
        this.config.logger.error('Workflow failed', { workflowId, error: serialized });
      }
    } finally {
      this.runningWorkflows.delete(workflowId);
    }
  }

  // ===========================================================================
  // CANCELLATION HANDLING
  // ===========================================================================

  private async handleCancellation(
    workflowId: string,
    workflowDef: WorkflowDefinition<any, any, any, any, any, any, any, any, any, any>,
    context: WorkflowContextImpl<any, any, any, any, any, any>,
    args: unknown,
    reason: CancellationReasonInternal,
  ): Promise<void> {
    this.config.logger.info('Handling workflow cancellation', { workflowId, reason: reason.type });

    // Convert internal reason to public reason type
    const publicReason: CancellationReason<any> = reason.type === 'external'
      ? { type: 'external', data: reason.data }
      : reason.type === 'timeout'
        ? { type: 'timeout' }
        : { type: 'parent_cancelled' };

    // Run onBeforeCancelled if defined
    if (workflowDef.onBeforeCancelled) {
      try {
        await workflowDef.onBeforeCancelled({ ctx: context, args, reason: publicReason });
      } catch (err) {
        this.config.logger.error('onBeforeCancelled failed', { workflowId, error: err });
      }
    }

    // Unwind compensations
    await this.unwindCompensations(workflowId, context);

    // Run onAfterCancelled if defined
    if (workflowDef.onAfterCancelled) {
      try {
        await workflowDef.onAfterCancelled({ ctx: context, args, reason: publicReason });
      } catch (err) {
        this.config.logger.error('onAfterCancelled failed', { workflowId, error: err });
      }
    }

    // Mark workflow as cancelled
    await this.db.completeCancellation(workflowId);

    this.config.logger.info('Workflow cancelled', { workflowId });
  }

  // ===========================================================================
  // COMPENSATION UNWINDING
  // ===========================================================================

  private async unwindCompensations(
    workflowId: string,
    context: WorkflowContextImpl<any, any, any, any, any, any>,
  ): Promise<void> {
    const stack = context.getCompensationStack();

    this.config.logger.info('Unwinding compensations', {
      workflowId,
      count: stack.length,
    });

    // Process in reverse order (LIFO)
    for (let i = stack.length - 1; i >= 0; i--) {
      const entry = stack[i];
      const stepDef = entry.stepDef;

      if (!stepDef.compensate) continue;

      // Get the original step result
      const originalStep = await this.db.getStepExecution(workflowId, entry.functionId);
      if (!originalStep) continue;

      // Determine compensation result
      let compensationResult: import('../types').CompensationResult<any>;
      if (originalStep.status === 'complete') {
        const decoded = stepDef.execute.schema
          ? decodeWithSchema(stepDef.execute.schema, originalStep.result)
          : originalStep.result;
        compensationResult = { status: 'completed', data: decoded };
      } else {
        compensationResult = { status: 'cancelled' };
      }

      // Execute compensation with retry
      await this.executeCompensation(
        workflowId,
        entry,
        compensationResult,
      );
    }
  }

  private async executeCompensation(
    workflowId: string,
    entry: CompensationEntry,
    result: import('../types').CompensationResult<any>,
  ): Promise<void> {
    const stepDef = entry.stepDef;
    if (!stepDef.compensate) return;

    const actionType: import('./database').ActionType = entry.isTransaction
      ? 'compensate_transaction'
      : 'compensate_step';

    // Create compensation step execution
    // Get next function ID by counting existing steps
    const existingSteps = await this.db.getStepExecutions(workflowId);
    const functionId = existingSteps.length;

    const { id: stepExecutionId } = await this.db.createStepExecution({
      workflowId,
      functionId,
      functionName: `compensate:${stepDef.name}`,
      actionType,
      compensationToStepExecutionId: entry.stepExecutionId,
    });

    const opts = mergeRetryOptions(stepDef.compensate.opts);
    let attempts = 0;
    let lastError: Error | null = null;

    const killController = new AbortController();
    const running = this.runningWorkflows.get(workflowId);
    if (running?.killRequested) {
      killController.abort();
    }

    while (attempts < opts.maxAttempts) {
      attempts++;

      const attemptId = await this.db.createStepAttempt({
        stepExecutionId,
        executorId: this.executorId,
      });

      try {
        if (entry.isTransaction) {
          // Transaction compensation
          const client = await this.pool.connect();
          try {
            await client.query('BEGIN');
            await (stepDef as import('../types').TransactionDefinition<any, any>).compensate!.fn(
              { result, client, killSignal: killController.signal },
            );
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          } finally {
            client.release();
          }
        } else {
          // Step compensation
          await (stepDef as import('../types').StepDefinition<any, any>).compensate!.fn(
            { result, killSignal: killController.signal },
          );
        }

        // Success
        await this.db.completeStepAttempt(attemptId, null);
        await this.db.completeStepExecution(stepExecutionId, null);

        this.config.logger.debug('Compensation succeeded', {
          workflowId,
          stepName: stepDef.name,
          attempts,
        });

        return;

      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        await this.db.failStepAttempt(attemptId, serializeError(err));

        this.config.logger.warn('Compensation attempt failed', {
          workflowId,
          stepName: stepDef.name,
          attempt: attempts,
          error: lastError.message,
        });

        if (attempts >= opts.maxAttempts) {
          break;
        }

        // Wait before retry
        const delayMs = calculateBackoffMs(
          attempts,
          opts.intervalSeconds,
          opts.backoffRate,
          opts.maxIntervalSeconds,
        );
        await sleep(delayMs);
      }
    }

    // All retries exhausted - create compensation failure
    await this.db.failStepExecution(stepExecutionId, serializeError(lastError));
    await this.db.createCompensationFailure(stepExecutionId);

    this.config.logger.error('Compensation failed, requires manual resolution', {
      workflowId,
      stepName: stepDef.name,
      attempts,
    });

    // Note: We don't throw here - we continue with other compensations
    // The workflow will be marked as cancelled but with a pending compensation failure
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  private calculateRetention(retention: number | RetentionSettings | undefined | 'immortal'): {
    completeRetentionDeadlineAt: Date | null;
    failedRetentionDeadlineAt: Date | null;
    cancelledRetentionDeadlineAt: Date | null;
    killedRetentionDeadlineAt: Date | null;
  } {
    const now = Date.now();

    if (retention === undefined || retention === 'immortal') {
      return {
        completeRetentionDeadlineAt: null,
        failedRetentionDeadlineAt: null,
        cancelledRetentionDeadlineAt: null,
        killedRetentionDeadlineAt: null,
      };
    }

    if (typeof retention === 'number') {
      const deadline = new Date(now + retention * 1000);
      return {
        completeRetentionDeadlineAt: deadline,
        failedRetentionDeadlineAt: deadline,
        cancelledRetentionDeadlineAt: deadline,
        killedRetentionDeadlineAt: deadline,
      };
    }

    return {
      completeRetentionDeadlineAt: retention.completed != null ? new Date(now + retention.completed * 1000) : null,
      failedRetentionDeadlineAt: retention.failed != null ? new Date(now + retention.failed * 1000) : null,
      cancelledRetentionDeadlineAt: retention.cancelled != null ? new Date(now + retention.cancelled * 1000) : null,
      killedRetentionDeadlineAt: retention.killed != null ? new Date(now + retention.killed * 1000) : null,
    };
  }

  private createExternalHandle(
    workflow: WorkflowDefinition<any, any, any, any, any, any, any, any, any, any>,
    workflowId: string,
  ): WorkflowHandleExternal<any, any, any, any, any, any> {
    // Import here to avoid circular dependency
    return new WorkflowHandleExternalImpl(
      this.db,
      this.notifications,
      this,
      workflowId,
      workflow,
    );
  }
}

// =============================================================================
// EXTERNAL HANDLE IMPLEMENTATION
// =============================================================================

class WorkflowHandleExternalImpl<
  TResult,
  TChannels extends import('../types').ChannelDefinitions,
  TStreams extends import('../types').StreamDefinitions,
  TEvents extends import('../types').EventDefinitions,
  TQueries extends import('../types').QueryDefinitions<any>,
  TCancelData,
> implements WorkflowHandleExternal<TResult, TChannels, TStreams, TEvents, TQueries, TCancelData>
{
  readonly workflowId: string;
  readonly channels: {
    [K in keyof TChannels]: import('../types').ChannelAccessorExternal<z.input<TChannels[K]>>;
  };
  readonly streams: {
    [K in keyof TStreams]: import('../types').StreamAccessorExternal<z.output<TStreams[K]>>;
  };
  readonly events: {
    [K in keyof TEvents]: import('../types').EventAccessorExternal;
  };
  readonly queries: {
    [K in keyof TQueries]: TQueries[K] extends import('../types').QueryDefinitionWithSchema<any, infer TResultSchema>
      ? import('../types').QueryAccessorExternal<z.output<TResultSchema>>
      : never;
  };

  constructor(
    private readonly db: DatabaseOperations,
    private readonly notifications: NotificationsManager,
    private readonly executor: WorkflowExecutor,
    workflowId: string,
    private readonly workflowDef: WorkflowDefinition<any, TChannels, TStreams, TEvents, TQueries, any, any, any, any, TCancelData>,
  ) {
    this.workflowId = workflowId;
    this.channels = this.buildChannelAccessors();
    this.streams = this.buildStreamAccessors();
    this.events = this.buildEventAccessors();
    this.queries = this.buildQueryAccessors();
  }

  async getStatus(): Promise<import('../types').WorkflowStatus<TCancelData>> {
    const workflow = await this.db.getWorkflow(this.workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${this.workflowId} not found`);
    }

    switch (workflow.status) {
      case 'pending':
        return { status: 'pending' };
      case 'running':
        return { status: 'running' };
      case 'cancelling':
        return { status: 'cancelling' };
      case 'complete':
        const resultSchema = this.workflowDef.result?.schema;
        return {
          status: 'completed',
          result: resultSchema
            ? decodeWithSchema(resultSchema, workflow.result)
            : workflow.result,
        };
      case 'failed':
        return { status: 'failed', error: String(workflow.result) };
      case 'cancelled':
        return {
          status: 'cancelled',
          reason: {
            type: workflow.cancellation_reason as any,
            data: undefined,
          } as CancellationReason<TCancelData>,
        };
      case 'killed':
        return { status: 'killed' };
    }
  }

  async getResult(options?: import('../types').TimeoutOption): Promise<import('../types').WorkflowResultResult<TResult, TCancelData>> {
    const timeoutMs = typeof options === 'number' ? options * 1000 : 30000;
    const terminalStatuses = ['complete', 'failed', 'cancelled', 'killed'];

    const status = await this.notifications.waitForWorkflowStatus(
      this.workflowId,
      terminalStatuses,
      async () => {
        const workflow = await this.db.getWorkflow(this.workflowId);
        if (!workflow) return 'not_found';
        if (terminalStatuses.includes(workflow.status)) {
          return workflow.status;
        }
        return null;
      },
      timeoutMs,
    );

    if (status === null) {
      return { ok: false, status: 'timeout' };
    }

    if (status === 'not_found') {
      return { ok: false, status: 'not_found' };
    }

    const workflow = await this.db.getWorkflow(this.workflowId);
    if (!workflow) {
      return { ok: false, status: 'not_found' };
    }

    switch (workflow.status) {
      case 'complete':
        const resultSchema = this.workflowDef.result?.schema;
        return {
          ok: true,
          status: 'completed',
          data: resultSchema
            ? decodeWithSchema(resultSchema, workflow.result)
            : workflow.result,
        };
      case 'failed':
        return { ok: false, status: 'failed', error: String(workflow.result) };
      case 'cancelled':
        return {
          ok: false,
          status: 'cancelled',
          reason: {
            type: workflow.cancellation_reason as any,
            data: undefined,
          } as CancellationReason<TCancelData>,
        };
      case 'killed':
        return { ok: false, status: 'killed' };
      default:
        return { ok: false, status: 'timeout' };
    }
  }

  async cancel(data?: TCancelData): Promise<import('../types').CancelResult> {
    return this.executor.requestCancellation(this.workflowId, { type: 'external', data });
  }

  async kill(): Promise<import('../types').KillResult> {
    return this.executor.requestKill(this.workflowId);
  }

  async setRetention(retention: number | RetentionSettings): Promise<void> {
    const now = Date.now();

    if (typeof retention === 'number') {
      const deadline = new Date(now + retention * 1000);
      await this.db.withTransaction(async (client) => {
        await client.query(
          `
          UPDATE ${this.db.schemaName}.workflow
          SET complete_retention_deadline_at = $2,
              failed_retention_deadline_at = $2,
              cancelled_retention_deadline_at = $2,
              killed_retention_deadline_at = $2,
              updated_at = NOW()
          WHERE id = $1
          `,
          [this.workflowId, deadline],
        );
      });
    } else {
      await this.db.withTransaction(async (client) => {
        await client.query(
          `
          UPDATE ${this.db.schemaName}.workflow
          SET complete_retention_deadline_at = $2,
              failed_retention_deadline_at = $3,
              cancelled_retention_deadline_at = $4,
              killed_retention_deadline_at = $5,
              updated_at = NOW()
          WHERE id = $1
          `,
          [
            this.workflowId,
            retention.completed != null ? new Date(now + retention.completed * 1000) : null,
            retention.failed != null ? new Date(now + retention.failed * 1000) : null,
            retention.cancelled != null ? new Date(now + retention.cancelled * 1000) : null,
            retention.killed != null ? new Date(now + retention.killed * 1000) : null,
          ],
        );
      });
    }
  }

  private buildChannelAccessors(): any {
    const channels = this.workflowDef.channels ?? {};
    const accessors: any = {};

    for (const [name, schema] of Object.entries(channels)) {
      accessors[name] = {
        send: async (data: any): Promise<import('../types').ChannelSendResult> => {
          const encoded = encodeWithSchema(schema as any, data);
          return this.db.sendChannelMessage({
            destWorkflowId: this.workflowId,
            channelName: name,
            body: encoded,
            sentFromWorkflow: false,
          });
        },
      };
    }

    return accessors;
  }

  private buildStreamAccessors(): any {
    const streams = this.workflowDef.streams ?? {};
    const accessors: any = {};

    for (const [name, schema] of Object.entries(streams)) {
      accessors[name] = {
        read: async (
          offset: number,
          options?: import('../types').TimeoutOption,
        ): Promise<import('../types').StreamReadResult<any>> => {
          const timeoutMs = typeof options === 'number' ? options * 1000 : 30000;

          // Check if workflow exists
          const exists = await this.db.workflowExists(this.workflowId);
          if (!exists) {
            return { ok: false, status: 'not_found' };
          }

          const record = await this.notifications.waitForStreamRecord(
            this.workflowId,
            name,
            offset,
            () => this.db.readStreamRecord(this.workflowId, name, offset),
            timeoutMs,
          );

          if (!record) {
            // Check if stream is closed
            const closed = await this.db.isStreamClosed(this.workflowId, name);
            if (closed) {
              return { ok: false, status: 'closed' };
            }
            return { ok: false, status: 'timeout' };
          }

          if (record.close_sentinel) {
            return { ok: false, status: 'closed' };
          }

          return {
            ok: true,
            status: 'received',
            data: decodeWithSchema(schema as any, record.body),
            offset: record.real_offset,
          };
        },

        isOpen: async (): Promise<import('../types').StreamOpenResult> => {
          const exists = await this.db.workflowExists(this.workflowId);
          if (!exists) {
            return { ok: false, status: 'not_found' };
          }

          const closed = await this.db.isStreamClosed(this.workflowId, name);
          if (closed) {
            return { ok: false, status: 'closed' };
          }

          return { ok: true, status: 'open' };
        },
      };
    }

    return accessors;
  }

  private buildEventAccessors(): any {
    const events = this.workflowDef.events ?? {};
    const accessors: any = {};

    for (const name of Object.keys(events)) {
      accessors[name] = {
        wait: async (options?: import('../types').TimeoutOption): Promise<import('../types').EventWaitResult> => {
          const timeoutMs = typeof options === 'number' ? options * 1000 : 30000;

          // Check if workflow exists
          const workflow = await this.db.getWorkflow(this.workflowId);
          if (!workflow) {
            return { ok: false, status: 'not_found' };
          }

          // Check if workflow is already finished
          if (['complete', 'failed', 'cancelled', 'killed'].includes(workflow.status)) {
            const isSet = await this.db.isEventSet(this.workflowId, name);
            if (isSet) {
              return { ok: true, status: 'set' };
            }
            return { ok: false, status: 'workflow_closed' };
          }

          const isSet = await this.notifications.waitForEvent(
            this.workflowId,
            name,
            () => this.db.isEventSet(this.workflowId, name),
            timeoutMs,
          );

          if (isSet) {
            return { ok: true, status: 'set' };
          }

          // Check if workflow finished while we were waiting
          const workflowNow = await this.db.getWorkflow(this.workflowId);
          if (workflowNow && ['complete', 'failed', 'cancelled', 'killed'].includes(workflowNow.status)) {
            return { ok: false, status: 'workflow_closed' };
          }

          return { ok: false, status: 'timeout' };
        },

        isSet: async (): Promise<import('../types').EventCheckResult> => {
          const exists = await this.db.workflowExists(this.workflowId);
          if (!exists) {
            return { ok: false, status: 'not_found' };
          }

          const isSet = await this.db.isEventSet(this.workflowId, name);
          if (isSet) {
            return { ok: true, status: 'set' };
          }

          return { ok: false, status: 'not_set' };
        },
      };
    }

    return accessors;
  }

  private buildQueryAccessors(): any {
    const queries = this.workflowDef.queries ?? {};
    const accessors: any = {};

    for (const [name, queryDef] of Object.entries(queries)) {
      accessors[name] = {
        get: async (options?: import('../types').TimeoutOption): Promise<import('../types').QueryResult<any>> => {
          const timeoutMs = typeof options === 'number' ? options * 1000 : 30000;

          // Check if workflow exists
          const exists = await this.db.workflowExists(this.workflowId);
          if (!exists) {
            return { ok: false, status: 'not_found' };
          }

          // Try to get running workflow
          let running = this.executor.getRunningWorkflow(this.workflowId);

          if (!running) {
            // Need to spin up the workflow for query
            // This is the Temporal-style approach
            // For now, we'll wait for it to be picked up by a worker
            const deadline = Date.now() + timeoutMs;

            while (!running && Date.now() < deadline) {
              await this.notifications.waitForAny('workflow_status', 1000);
              running = this.executor.getRunningWorkflow(this.workflowId);
            }

            if (!running) {
              return { ok: false, status: 'timeout' };
            }
          }

          // Execute query on the context's state
          const result = (queryDef as any).fn(running.context.state);
          const encoded = encodeWithSchema((queryDef as any).schema, result);

          return {
            ok: true,
            status: 'success',
            data: decodeWithSchema((queryDef as any).schema, encoded),
          };
        },
      };
    }

    return accessors;
  }
}

