import type { z } from "zod";
import type {
  WorkflowContext,
  WorkflowLogger,
  ChannelDefinitions,
  StreamDefinitions,
  EventDefinitions,
  StepDefinitions,
  TransactionDefinitions,
  WorkflowDefinitions,
  ChannelAccessor,
  StreamAccessor,
  EventAccessor,
  ChannelReceiveResult,
  DeterministicRNG,
  StepDefinition,
  TransactionDefinition,
  RetryPolicyOptions,
  WorkflowDefinition,
  RuntimeStepOptionsWithCompensation,
  RuntimeStepOptionsWithoutCompensation,
  WorkflowAccessor,
} from "../types";
import type { Pool } from "pg";
import type { WorkflowHandleInternal, WorkflowResultResult } from "../types";
import type {
  DatabaseOperations,
  StepExecutionRow,
  ActionType,
} from "./database";
import type { NotificationsManager } from "./notifications";
import { RNGManager } from "./rng";
import { serializeError, deserializeError } from "./serialization";
import {
  mergeRetryOptions,
  calculateBackoffMs,
  sleep,
  sleepUntil,
  parseTimeoutMs,
} from "./utils";
import {
  WorkflowCancelledError,
  WorkflowKilledError,
  StepCancelledError,
  MaxRetriesExceededError,
  NonDeterminismError,
  StepTimeoutError,
  type CancellationReasonInternal,
} from "./errors";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Entry in the compensation stack
 */
export interface CompensationEntry {
  stepExecutionId: bigint;
  functionId: number;
  stepDef: StepDefinition<any[], any> | TransactionDefinition<any[], any>;
  isTransaction: boolean;
}

/**
 * Parameters for creating a WorkflowContext
 */
export interface WorkflowContextParams {
  workflowId: string;
  workflowDef: WorkflowDefinition<
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
  db: DatabaseOperations;
  notifications: NotificationsManager;
  pool: Pool;
  executorId: string;
  seed: string;
  createdAt: Date;
  initialState: unknown;
  stepExecutions: StepExecutionRow[];
  onCancellationRequested: () => CancellationReasonInternal | null;
  onKillRequested: () => boolean;
}

// =============================================================================
// REPLAY-AWARE LOGGER
// =============================================================================

class ReplayAwareLogger implements WorkflowLogger {
  constructor(
    private readonly baseLogger: {
      debug: (msg: string, data?: Record<string, unknown>) => void;
      info: (msg: string, data?: Record<string, unknown>) => void;
      warn: (msg: string, data?: Record<string, unknown>) => void;
      error: (msg: string, data?: Record<string, unknown>) => void;
    },
    private readonly isPastReplayBoundary: () => boolean
  ) {}

  debug(message: string, data?: Record<string, unknown>): void {
    if (this.isPastReplayBoundary()) {
      this.baseLogger.debug(message, data);
    }
  }

  info(message: string, data?: Record<string, unknown>): void {
    if (this.isPastReplayBoundary()) {
      this.baseLogger.info(message, data);
    }
  }

  warn(message: string, data?: Record<string, unknown>): void {
    if (this.isPastReplayBoundary()) {
      this.baseLogger.warn(message, data);
    }
  }

  error(message: string, data?: Record<string, unknown>): void {
    if (this.isPastReplayBoundary()) {
      this.baseLogger.error(message, data);
    }
  }
}

// =============================================================================
// WORKFLOW CONTEXT IMPLEMENTATION
// =============================================================================

export class WorkflowContextImpl<
  TState,
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TSteps extends StepDefinitions,
  TTransactions extends TransactionDefinitions,
  TWorkflows extends WorkflowDefinitions
> implements
    WorkflowContext<
      TState,
      TChannels,
      TStreams,
      TEvents,
      TSteps,
      TTransactions,
      TWorkflows
    >
{
  readonly workflowId: string;
  readonly state: TState;
  readonly logger: WorkflowLogger;
  readonly channels: {
    [K in keyof TChannels]: ChannelAccessor<z.output<TChannels[K]>>;
  };
  readonly streams: {
    [K in keyof TStreams]: StreamAccessor<z.input<TStreams[K]>>;
  };
  readonly events: { [K in keyof TEvents]: EventAccessor };
  readonly steps: {
    [K in keyof TSteps]: TSteps[K] extends StepDefinition<
      infer TArgs,
      infer TResultSchema
    >
      ? TSteps[K] extends { compensate: { fn: (...args: any[]) => any } }
        ? (
            ...args: [...TArgs, RuntimeStepOptionsWithCompensation?]
          ) => Promise<z.output<TResultSchema>>
        : (
            ...args: [...TArgs, RuntimeStepOptionsWithoutCompensation?]
          ) => Promise<z.output<TResultSchema>>
      : never;
  };
  readonly transactions: {
    [K in keyof TTransactions]: TTransactions[K] extends TransactionDefinition<
      infer TArgs,
      infer TResultSchema
    >
      ? TTransactions[K] extends { compensate: { fn: (...args: any[]) => any } }
        ? (
            ...args: [...TArgs, RuntimeStepOptionsWithCompensation?]
          ) => Promise<z.output<TResultSchema>>
        : (
            ...args: [...TArgs, RuntimeStepOptionsWithoutCompensation?]
          ) => Promise<z.output<TResultSchema>>
      : never;
  };
  readonly workflows: {
    [K in keyof TWorkflows]: WorkflowAccessor<TWorkflows[K]>;
  };

  readonly timestamp: number;
  readonly date: Date;

  // Internal state
  private functionIdCounter = 0;
  private readonly replayBoundary: number;
  private readonly stepExecutionCache: Map<number, StepExecutionRow>;
  private readonly compensationStack: CompensationEntry[] = [];
  private readonly rngManager: RNGManager;
  private readonly streamOffsets: Map<string, number> = new Map();

  // Dependencies
  private readonly db: DatabaseOperations;
  private readonly notifications: NotificationsManager;
  private readonly pool: import("pg").Pool;
  private readonly executorId: string;
  private readonly workflowDef: WorkflowDefinition<
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
  private readonly onCancellationRequested: () => CancellationReasonInternal | null;
  private readonly onKillRequested: () => boolean;

  constructor(params: WorkflowContextParams) {
    this.workflowId = params.workflowId;
    this.db = params.db;
    this.notifications = params.notifications;
    this.pool = params.pool;
    this.executorId = params.executorId;
    this.workflowDef = params.workflowDef;
    this.onCancellationRequested = params.onCancellationRequested;
    this.onKillRequested = params.onKillRequested;

    // Set deterministic timestamp from workflow creation
    this.timestamp = params.createdAt.getTime();
    this.date = params.createdAt;

    // Initialize RNG manager
    this.rngManager = new RNGManager(params.seed);

    // Build step execution cache and find replay boundary
    this.stepExecutionCache = new Map();
    let maxCompletedFunctionId = -1;

    for (const step of params.stepExecutions) {
      this.stepExecutionCache.set(step.function_id, step);
      if (
        step.status === "complete" &&
        step.function_id > maxCompletedFunctionId
      ) {
        maxCompletedFunctionId = step.function_id;
      }
    }
    this.replayBoundary = maxCompletedFunctionId;

    // Initialize state
    this.state = params.initialState as TState;

    // Create replay-aware logger
    this.logger = new ReplayAwareLogger(console, () =>
      this.isPastReplayBoundary()
    );

    // Build step proxies
    this.steps = this.buildStepProxies() as any;
    this.transactions = this.buildTransactionProxies() as any;
    this.workflows = this.buildWorkflowProxies() as any;

    // Build primitive proxies
    this.channels = this.buildChannelProxies() as any;
    this.streams = this.buildStreamProxies() as any;
    this.events = this.buildEventProxies() as any;
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  async sleep(seconds: number): Promise<void> {
    const functionId = this.nextFunctionId();
    this.checkCancellation();

    // Check for existing step (replay)
    const existing = this.stepExecutionCache.get(functionId);
    if (existing) {
      this.validateStepType(existing, "sleep", "sleep");
      if (existing.status === "complete") {
        return; // Already completed
      }
    }

    const sleepEndAt = new Date(Date.now() + seconds * 1000);
    const sleepDuration = `${seconds} seconds`;

    // Create step execution (atomically)
    await this.db.createStepExecution({
      workflowId: this.workflowId,
      functionId,
      functionName: "sleep",
      actionType: "sleep",
      sleepEndAt,
      sleepDuration,
      status: "complete", // Sleep is immediately "complete"
    });

    // Actually sleep
    await sleepUntil(sleepEndAt);
  }

  rng(name: string): DeterministicRNG {
    return this.rngManager.get(name);
  }

  // ===========================================================================
  // COMPENSATION STACK
  // ===========================================================================

  /**
   * Get the compensation stack for unwinding
   */
  getCompensationStack(): CompensationEntry[] {
    return [...this.compensationStack];
  }

  // ===========================================================================
  // INTERNAL HELPERS
  // ===========================================================================

  private nextFunctionId(): number {
    return this.functionIdCounter++;
  }

  private isPastReplayBoundary(): boolean {
    return this.functionIdCounter > this.replayBoundary;
  }

  private checkCancellation(): void {
    const cancellation = this.onCancellationRequested();
    if (cancellation) {
      throw new WorkflowCancelledError(this.workflowId, cancellation);
    }
    if (this.onKillRequested()) {
      throw new WorkflowKilledError(this.workflowId);
    }
  }

  private validateStepType(
    existing: StepExecutionRow,
    expectedActionType: ActionType,
    expectedFunctionName: string
  ): void {
    if (existing.action_type !== expectedActionType) {
      throw new NonDeterminismError(
        this.workflowId,
        `action_type=${expectedActionType}`,
        `action_type=${existing.action_type}`
      );
    }
    if (existing.function_name !== expectedFunctionName) {
      throw new NonDeterminismError(
        this.workflowId,
        `function_name=${expectedFunctionName}`,
        `function_name=${existing.function_name}`
      );
    }
  }

  // ===========================================================================
  // STEP PROXIES
  // ===========================================================================

  private buildStepProxies(): Record<string, (...args: any[]) => Promise<any>> {
    const steps: Record<string, StepDefinition<any[], any>> = this.workflowDef
      .steps ?? {};
    const proxies: Record<string, (...args: any[]) => Promise<any>> = {};

    for (const [name, stepDef] of Object.entries(steps)) {
      proxies[name] = async (...args: any[]) => {
        // Check if last arg is options
        let runtimeOpts: RetryPolicyOptions | undefined;
        let stepArgs = args;

        if (args.length > 0) {
          const lastArg = args[args.length - 1];
          if (
            lastArg &&
            typeof lastArg === "object" &&
            ("executeOpts" in lastArg || "compensateOpts" in lastArg)
          ) {
            runtimeOpts = lastArg.executeOpts;
            stepArgs = args.slice(0, -1);
          }
        }

        return this.executeStep(stepDef, stepArgs, runtimeOpts);
      };
    }

    return proxies;
  }

  private async executeStep(
    stepDef: StepDefinition<any[], any>,
    args: any[],
    runtimeOpts?: RetryPolicyOptions
  ): Promise<any> {
    const functionId = this.nextFunctionId();
    this.checkCancellation();

    // Check for existing step (replay)
    const existing = this.stepExecutionCache.get(functionId);
    if (existing) {
      this.validateStepType(existing, "execute_step", stepDef.name);

      if (existing.status === "complete") {
        // Return cached result (decoded)
        return stepDef.execute.schema.parse(existing.result);
      }
      if (existing.status === "failed") {
        throw deserializeError(existing.result as any);
      }
      if (existing.status === "cancelled") {
        throw new StepCancelledError(
          functionId,
          existing.cancellation_reason as any
        );
      }
    }

    // Create step execution record
    const { id: stepExecutionId, isNew } = await this.db.createStepExecution({
      workflowId: this.workflowId,
      functionId,
      functionName: stepDef.name,
      actionType: "execute_step",
    });

    // If not new, another worker may have created it - fetch and check
    if (!isNew) {
      const step = await this.db.getStepExecution(this.workflowId, functionId);
      if (step?.status === "complete") {
        return stepDef.execute.schema.parse(step.result);
      }
    }

    // Add to compensation stack if has compensate
    if (stepDef.compensate) {
      this.compensationStack.push({
        stepExecutionId,
        functionId,
        stepDef,
        isTransaction: false,
      });
    }

    // Execute with retry logic
    const opts = mergeRetryOptions(stepDef.execute.opts, runtimeOpts);
    const result = await this.executeWithRetry(
      stepExecutionId,
      stepDef,
      args,
      opts
    );

    // Encode result
    const encoded = stepDef.execute.schema.encode(result);

    // Store result
    await this.db.completeStepExecution(stepExecutionId, encoded);

    // Return decoded result
    return stepDef.execute.schema.parse(encoded);
  }

  private async executeWithRetry(
    stepExecutionId: bigint,
    stepDef: StepDefinition<any[], any>,
    args: any[],
    opts: Required<RetryPolicyOptions>
  ): Promise<any> {
    let attempts = 0;
    let lastError: Error | null = null;

    while (attempts < opts.maxAttempts) {
      attempts++;
      this.checkCancellation();

      // Create attempt record
      const attemptId = await this.db.createStepAttempt({
        stepExecutionId,
        executorId: this.executorId,
        deadlineAt:
          opts.timeoutSeconds > 0
            ? new Date(Date.now() + opts.timeoutSeconds * 1000)
            : undefined,
      });

      try {
        // Set up abort controller for timeout
        const controller = new AbortController();
        let timeoutId: NodeJS.Timeout | null = null;

        if (opts.timeoutSeconds > 0) {
          timeoutId = setTimeout(
            () =>
              controller.abort(
                new StepTimeoutError(stepDef.name, opts.timeoutSeconds)
              ),
            opts.timeoutSeconds * 1000
          );
        }

        try {
          // Execute the step function
          const result = await stepDef.execute.fn(
            { signal: controller.signal },
            ...args
          );

          // Success
          await this.db.completeStepAttempt(attemptId, null);
          return result;
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        await this.db.failStepAttempt(attemptId, serializeError(err));

        // Check if we should retry
        if (attempts >= opts.maxAttempts) {
          break;
        }

        // Wait before retry (exponential backoff)
        const delayMs = calculateBackoffMs(
          attempts,
          opts.intervalSeconds,
          opts.backoffRate,
          opts.maxIntervalSeconds
        );
        await sleep(delayMs);
      }
    }

    // All retries exhausted
    throw new MaxRetriesExceededError(stepDef.name, attempts, lastError!);
  }

  // ===========================================================================
  // TRANSACTION PROXIES
  // ===========================================================================

  private buildTransactionProxies(): Record<
    string,
    (...args: any[]) => Promise<any>
  > {
    const transactions: Record<string, TransactionDefinition<any[], any>> = this
      .workflowDef.transactions ?? {};
    const proxies: Record<string, (...args: any[]) => Promise<any>> = {};

    for (const [name, txnDef] of Object.entries(transactions)) {
      proxies[name] = async (...args: any[]) => {
        // Check if last arg is options
        let runtimeOpts: RetryPolicyOptions | undefined;
        let txnArgs = args;

        if (args.length > 0) {
          const lastArg = args[args.length - 1];
          if (
            lastArg &&
            typeof lastArg === "object" &&
            ("executeOpts" in lastArg || "compensateOpts" in lastArg)
          ) {
            runtimeOpts = lastArg.executeOpts;
            txnArgs = args.slice(0, -1);
          }
        }

        return this.executeTransaction(txnDef, txnArgs, runtimeOpts);
      };
    }

    return proxies;
  }

  private async executeTransaction(
    txnDef: TransactionDefinition<any[], any>,
    args: any[],
    runtimeOpts?: RetryPolicyOptions
  ): Promise<any> {
    const functionId = this.nextFunctionId();
    this.checkCancellation();

    // Check for existing step (replay)
    const existing = this.stepExecutionCache.get(functionId);
    if (existing) {
      this.validateStepType(existing, "execute_transaction", txnDef.name);

      if (existing.status === "complete") {
        return txnDef.execute.schema.parse(existing.result);
      }
      if (existing.status === "failed") {
        throw deserializeError(existing.result as any);
      }
      if (existing.status === "cancelled") {
        throw new StepCancelledError(
          functionId,
          existing.cancellation_reason as any
        );
      }
    }

    // Create step execution record
    const { id: stepExecutionId, isNew } = await this.db.createStepExecution({
      workflowId: this.workflowId,
      functionId,
      functionName: txnDef.name,
      actionType: "execute_transaction",
    });

    if (!isNew) {
      const step = await this.db.getStepExecution(this.workflowId, functionId);
      if (step?.status === "complete") {
        return txnDef.execute.schema.parse(step.result);
      }
    }

    // Add to compensation stack if has compensate
    if (txnDef.compensate) {
      this.compensationStack.push({
        stepExecutionId,
        functionId,
        stepDef: txnDef,
        isTransaction: true,
      });
    }

    // Execute with retry logic
    const opts = mergeRetryOptions(txnDef.execute.opts, runtimeOpts);
    const result = await this.executeTransactionWithRetry(
      stepExecutionId,
      txnDef,
      args,
      opts
    );

    // Encode result
    const encoded = txnDef.execute.schema.encode(result);

    // Store result
    await this.db.completeStepExecution(stepExecutionId, encoded);

    return decodeWithSchema(txnDef.execute.schema, encoded);
  }

  private async executeTransactionWithRetry(
    stepExecutionId: bigint,
    txnDef: TransactionDefinition<any[], any>,
    args: any[],
    opts: Required<RetryPolicyOptions>
  ): Promise<any> {
    let attempts = 0;
    let lastError: Error | null = null;

    while (attempts < opts.maxAttempts) {
      attempts++;
      this.checkCancellation();

      const attemptId = await this.db.createStepAttempt({
        stepExecutionId,
        executorId: this.executorId,
        deadlineAt:
          opts.timeoutSeconds > 0
            ? new Date(Date.now() + opts.timeoutSeconds * 1000)
            : undefined,
      });

      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");

        const controller = new AbortController();
        let timeoutId: NodeJS.Timeout | null = null;

        if (opts.timeoutSeconds > 0) {
          timeoutId = setTimeout(
            () =>
              controller.abort(
                new StepTimeoutError(txnDef.name, opts.timeoutSeconds)
              ),
            opts.timeoutSeconds * 1000
          );
        }

        try {
          const result = await txnDef.execute.fn(
            { client, signal: controller.signal },
            ...args
          );
          await client.query("COMMIT");
          await this.db.completeStepAttempt(attemptId, null);
          return result;
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }
      } catch (err) {
        await client.query("ROLLBACK");
        lastError = err instanceof Error ? err : new Error(String(err));
        await this.db.failStepAttempt(attemptId, serializeError(err));

        if (attempts >= opts.maxAttempts) {
          break;
        }

        const delayMs = calculateBackoffMs(
          attempts,
          opts.intervalSeconds,
          opts.backoffRate,
          opts.maxIntervalSeconds
        );
        await sleep(delayMs);
      } finally {
        client.release();
      }
    }

    throw new MaxRetriesExceededError(txnDef.name, attempts, lastError!);
  }

  // ===========================================================================
  // WORKFLOW PROXIES
  // ===========================================================================

  private buildWorkflowProxies(): Record<string, WorkflowAccessor<any>> {
    const workflows: Record<
      string,
      WorkflowDefinition<any, any, any, any, any, any, any, any, any, any, any>
    > = this.workflowDef.workflows ?? {};
    const proxies: Record<string, WorkflowAccessor<any>> = {};

    for (const [name, workflowDef] of Object.entries(workflows)) {
      proxies[name] = {
        start: async (options: any) => {
          return this.startChildWorkflowInternal(workflowDef, options);
        },
        get: (workflowId: string) => {
          return this.getWorkflowInternal(workflowDef, workflowId);
        },
      };
    }

    return proxies;
  }

  private getWorkflowInternal<TTargetChannels extends ChannelDefinitions>(
    workflow: WorkflowDefinition<
      any,
      TTargetChannels,
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
    workflowId: string
  ): import("../types").WorkflowHandleInternal<TTargetChannels> {
    return new WorkflowHandleInternalImpl(this.db, this, workflowId, workflow);
  }

  private async startChildWorkflowInternal<
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
      any,
      any
    >
  >(
    workflow: W,
    options: {
      workflowId: string;
      args?: unknown;
      initialState?: unknown;
      timeoutSeconds?: number;
    }
  ): Promise<ChildWorkflowHandleImpl<any, any>> {
    const functionId = this.nextFunctionId();
    this.checkCancellation();

    // Check for existing step (replay)
    const existing = this.stepExecutionCache.get(functionId);
    if (existing) {
      this.validateStepType(
        existing,
        "start_child_workflow",
        `startChildWorkflow:${workflow.name}`
      );
      if (existing.status === "complete") {
        // Child already started - return handle
        return new ChildWorkflowHandleImpl(
          this.db,
          this.notifications,
          this,
          options.workflowId,
          workflow
        );
      }
    }

    // Create start_child_workflow step execution
    const { id: stepExecutionId } = await this.db.createStepExecution({
      workflowId: this.workflowId,
      functionId,
      functionName: `startChildWorkflow:${workflow.name}`,
      actionType: "start_child_workflow",
      status: "complete",
    });

    // Encode args if schema provided
    const encodedArgs =
      workflow.argSchema && options.args !== undefined
        ? workflow.argSchema.encode(options.args)
        : options.args;

    // Create child workflow record
    await this.db.createWorkflow({
      id: options.workflowId,
      parentId: this.workflowId,
      name: workflow.name,
      arguments: encodedArgs,
      startedByStepExecutionId: stepExecutionId,
    });

    return new ChildWorkflowHandleImpl(
      this.db,
      this.notifications,
      this,
      options.workflowId,
      workflow
    );
  }

  // ===========================================================================
  // CHANNEL PROXIES
  // ===========================================================================

  private buildChannelProxies(): Record<string, ChannelAccessor<any>> {
    const channels = this.workflowDef.channels ?? {};
    const proxies: Record<string, ChannelAccessor<any>> = {};

    for (const [name, schema] of Object.entries(channels)) {
      proxies[name] = {
        receive: async (
          timeoutSeconds?: number
        ): Promise<ChannelReceiveResult<any>> => {
          const functionId = this.nextFunctionId();
          this.checkCancellation();

          // Check for existing step (replay)
          const existing = this.stepExecutionCache.get(functionId);
          if (existing) {
            this.validateStepType(
              existing,
              "receive_from_channel",
              `receive:${name}`
            );
            if (existing.status === "complete") {
              if (existing.result === null) {
                return { ok: false, status: "timeout" };
              }
              return {
                ok: true,
                status: "received",
                data: decodeWithSchema(schema, existing.result),
              };
            }
          }

          // Create step execution
          const { id: stepExecutionId } = await this.db.createStepExecution({
            workflowId: this.workflowId,
            functionId,
            functionName: `receive:${name}`,
            actionType: "receive_from_channel",
            channelName: name,
          });

          // Try to consume a message with LISTEN/NOTIFY + polling
          const timeoutMs = parseTimeoutMs(timeoutSeconds, 30000);

          const message = await this.notifications.waitForChannelMessage(
            this.workflowId,
            name,
            () => this.db.consumeChannelMessage(this.workflowId, name),
            timeoutMs
          );

          if (message) {
            const decoded = decodeWithSchema(schema, message.body);
            await this.db.completeStepExecution(stepExecutionId, message.body);
            return { ok: true, status: "received", data: decoded };
          } else {
            await this.db.completeStepExecution(stepExecutionId, null);
            return { ok: false, status: "timeout" };
          }
        },
      };
    }

    return proxies;
  }

  // ===========================================================================
  // STREAM PROXIES
  // ===========================================================================

  private buildStreamProxies(): Record<string, StreamAccessor<any>> {
    const streams = this.workflowDef.streams ?? {};
    const proxies: Record<string, StreamAccessor<any>> = {};

    for (const [name, schema] of Object.entries(streams)) {
      proxies[name] = {
        write: async (data: any): Promise<number> => {
          const functionId = this.nextFunctionId();
          this.checkCancellation();

          // Check for existing step (replay)
          const existing = this.stepExecutionCache.get(functionId);
          if (existing) {
            this.validateStepType(existing, "write_to_stream", `write:${name}`);
            if (existing.status === "complete") {
              // Get the offset from the stream record
              const offset = this.streamOffsets.get(name) ?? 0;
              this.streamOffsets.set(name, offset + 1);
              return offset;
            }
          }

          // Get next offset
          const offset = await this.db.getStreamNextOffset(
            this.workflowId,
            name
          );
          this.streamOffsets.set(name, offset + 1);

          // Create step execution
          const { id: stepExecutionId } = await this.db.createStepExecution({
            workflowId: this.workflowId,
            functionId,
            functionName: `write:${name}`,
            actionType: "write_to_stream",
            streamName: name,
            status: "complete",
          });

          // Write the record
          const encoded = encodeWithSchema(schema, data);
          await this.db.writeStreamRecord({
            writtenByStepExecutionId: stepExecutionId,
            workflowId: this.workflowId,
            streamName: name,
            body: encoded,
            offset,
          });

          return offset;
        },

        close: async (): Promise<void> => {
          const functionId = this.nextFunctionId();
          this.checkCancellation();

          // Check for existing step (replay)
          const existing = this.stepExecutionCache.get(functionId);
          if (existing) {
            this.validateStepType(existing, "close_stream", `close:${name}`);
            if (existing.status === "complete") {
              return;
            }
          }

          // Get next offset for the close sentinel
          const offset = await this.db.getStreamNextOffset(
            this.workflowId,
            name
          );

          // Create step execution
          const { id: stepExecutionId } = await this.db.createStepExecution({
            workflowId: this.workflowId,
            functionId,
            functionName: `close:${name}`,
            actionType: "close_stream",
            streamName: name,
            status: "complete",
          });

          // Write the close sentinel
          await this.db.closeStream({
            writtenByStepExecutionId: stepExecutionId,
            workflowId: this.workflowId,
            streamName: name,
            offset,
          });
        },
      };
    }

    return proxies;
  }

  // ===========================================================================
  // EVENT PROXIES
  // ===========================================================================

  private buildEventProxies(): Record<string, EventAccessor> {
    const events = this.workflowDef.events ?? {};
    const proxies: Record<string, EventAccessor> = {};

    for (const name of Object.keys(events)) {
      proxies[name] = {
        set: async (): Promise<void> => {
          const functionId = this.nextFunctionId();
          this.checkCancellation();

          // Check for existing step (replay)
          const existing = this.stepExecutionCache.get(functionId);
          if (existing) {
            this.validateStepType(existing, "set_event", `set:${name}`);
            if (existing.status === "complete") {
              return;
            }
          }

          // Create step execution
          const { id: stepExecutionId } = await this.db.createStepExecution({
            workflowId: this.workflowId,
            functionId,
            functionName: `set:${name}`,
            actionType: "set_event",
            eventName: name,
            status: "complete",
          });

          // Set the event (idempotent)
          await this.db.setEvent({
            setByStepExecutionId: stepExecutionId,
            workflowId: this.workflowId,
            eventName: name,
          });
        },
      };
    }

    return proxies;
  }
}

// =============================================================================
// INTERNAL WORKFLOW HANDLE (for cross-workflow communication)
// =============================================================================

class WorkflowHandleInternalImpl<TChannels extends ChannelDefinitions>
  implements WorkflowHandleInternal<TChannels>
{
  readonly workflowId: string;
  readonly channels: {
    [K in keyof TChannels]: {
      send(data: z.input<TChannels[K]>): Promise<void>;
    };
  };

  constructor(
    private readonly db: DatabaseOperations,
    private readonly ctx: WorkflowContextImpl<any, any, any, any, any, any>,
    workflowId: string,
    workflow: WorkflowDefinition<
      any,
      TChannels,
      any,
      any,
      any,
      any,
      any,
      any,
      any,
      any
    >
  ) {
    this.workflowId = workflowId;

    // Build channel proxies
    const channelDefs = workflow.channels ?? {};
    const proxies: any = {};

    for (const [name, schema] of Object.entries(channelDefs)) {
      proxies[name] = {
        send: async (data: any): Promise<void> => {
          const functionId = this.ctx["nextFunctionId"]();
          this.ctx["checkCancellation"]();

          // Check for existing step (replay)
          const existing = this.ctx["stepExecutionCache"].get(functionId);
          if (existing) {
            this.ctx["validateStepType"](
              existing,
              "send_to_channel",
              `send:${workflowId}:${name}`
            );
            if (existing.status === "complete") {
              return; // Already sent (fire-and-forget, so we don't care about result)
            }
          }

          // Create step execution
          const { id: stepExecutionId } = await this.db.createStepExecution({
            workflowId: this.ctx.workflowId,
            functionId,
            functionName: `send:${workflowId}:${name}`,
            actionType: "send_to_channel",
            channelName: name,
            status: "complete",
          });

          // Send the message (fire-and-forget - we don't care if workflow exists)
          const encoded = encodeWithSchema(schema as any, data);
          await this.db.sendChannelMessage({
            destWorkflowId: workflowId,
            channelName: name,
            body: encoded,
            sentFromWorkflow: true,
            sentByStepExecutionId: stepExecutionId,
          });
        },
      };
    }

    this.channels = proxies;
  }
}

// =============================================================================
// CHILD WORKFLOW HANDLE
// =============================================================================

class ChildWorkflowHandleImpl<TResult, TCancelData> {
  readonly workflowId: string;

  constructor(
    private readonly db: DatabaseOperations,
    private readonly notifications: NotificationsManager,
    private readonly parentCtx: WorkflowContextImpl<
      any,
      any,
      any,
      any,
      any,
      any
    >,
    workflowId: string,
    private readonly workflow: WorkflowDefinition<
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
    >
  ) {
    this.workflowId = workflowId;
  }

  async getResult(
    timeoutSeconds?: number
  ): Promise<WorkflowResultResult<TResult, TCancelData>> {
    const functionId = this.parentCtx["nextFunctionId"]();
    this.parentCtx["checkCancellation"]();

    // Check for existing step (replay)
    const existing = this.parentCtx["stepExecutionCache"].get(functionId);
    if (existing) {
      this.parentCtx["validateStepType"](
        existing,
        "wait_for_child_workflow_result",
        `waitResult:${this.workflowId}`
      );
      if (existing.status === "complete") {
        // Return cached result
        const workflow = await this.db.getWorkflow(this.workflowId);
        if (!workflow) {
          return { ok: false, status: "not_found" };
        }
        return this.workflowToResult(workflow);
      }
    }

    // Create step execution
    const { id: stepExecutionId } = await this.db.createStepExecution({
      workflowId: this.parentCtx.workflowId,
      functionId,
      functionName: `waitResult:${this.workflowId}`,
      actionType: "wait_for_child_workflow_result",
    });

    // Wait for the child workflow to complete
    const timeoutMs = parseTimeoutMs(timeoutSeconds, 30000);
    const terminalStatuses = ["complete", "failed", "cancelled", "killed"];

    const status = await this.notifications.waitForWorkflowStatus(
      this.workflowId,
      terminalStatuses,
      async () => {
        const workflow = await this.db.getWorkflow(this.workflowId);
        if (!workflow) return "not_found";
        if (terminalStatuses.includes(workflow.status)) {
          return workflow.status;
        }
        return null;
      },
      timeoutMs
    );

    // Mark step as complete
    await this.db.completeStepExecution(stepExecutionId, null);

    if (status === null) {
      return { ok: false, status: "timeout" };
    }

    const workflow = await this.db.getWorkflow(this.workflowId);
    if (!workflow) {
      return { ok: false, status: "not_found" };
    }

    return this.workflowToResult(workflow);
  }

  private workflowToResult(
    workflow: import("./database").WorkflowRow
  ): import("../types").WorkflowResultResult<TResult, TCancelData> {
    switch (workflow.status) {
      case "complete":
        const resultSchema = this.workflow.result?.schema;
        const data = resultSchema
          ? decodeWithSchema(resultSchema, workflow.result)
          : workflow.result;
        return { ok: true, status: "completed", data: data as TResult };

      case "failed":
        return { ok: false, status: "failed", error: String(workflow.result) };

      case "cancelled":
        return {
          ok: false,
          status: "cancelled",
          reason: {
            type: workflow.cancellation_reason as any,
            data: undefined,
          } as any,
        };

      case "killed":
        return { ok: false, status: "killed" };

      default:
        // Should not happen for terminal states
        return { ok: false, status: "timeout" };
    }
  }
}

// Export for use in handles.ts
export { ChildWorkflowHandleImpl };
