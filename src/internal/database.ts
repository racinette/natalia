import type { Pool, PoolClient } from 'pg';
import { isPgError, PG_ERROR } from './utils';

// =============================================================================
// TYPES
// =============================================================================

export type WorkflowStatus =
  | 'pending'
  | 'running'
  | 'cancelling'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'killed';

export type StepStatus =
  | 'pending'
  | 'running'
  | 'cancelling'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'killed';

export type ActionType =
  | 'execute_step'
  | 'compensate_step'
  | 'execute_transaction'
  | 'compensate_transaction'
  | 'sleep'
  | 'send_to_channel'
  | 'receive_from_channel'
  | 'write_to_stream'
  | 'close_stream'
  | 'set_event'
  | 'start_child_workflow'
  | 'wait_for_child_workflow_result';

export interface WorkflowRow {
  id: string;
  parent_id: string | null;
  name: string;
  status: WorkflowStatus;
  cancellation_reason: string | null;
  arguments: unknown;
  result: unknown;
  executor_id: string | null;
  seed: string;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  deadline_at: Date | null;
  complete_retention_deadline_at: Date | null;
  failed_retention_deadline_at: Date | null;
  cancelled_retention_deadline_at: Date | null;
  killed_retention_deadline_at: Date | null;
  started_by_step_execution_id: bigint | null;
}

export interface StepExecutionRow {
  id: bigint;
  workflow_id: string;
  function_id: number;
  is_final: boolean;
  function_name: string;
  action_type: ActionType;
  cancellation_reason: string | null;
  status: StepStatus;
  result: unknown;
  channel_name: string | null;
  stream_name: string | null;
  event_name: string | null;
  sleep_end_at: Date | null;
  sleep_duration: string | null;
  compensation_to_step_execution_id: bigint | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  deadline_at: Date | null;
}

export interface StepAttemptRow {
  id: bigint;
  step_execution_id: bigint;
  executor_id: string | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  deadline_at: Date | null;
  cancellation_reason: string | null;
  status: StepStatus;
  result: unknown;
}

export interface ChannelMessageRow {
  id: bigint;
  sent_from_workflow: boolean;
  sent_by_step_execution_id: bigint | null;
  seq_num: bigint;
  dest_workflow_id: string;
  channel_name: string;
  body: unknown;
  created_at: Date;
}

export interface StreamRecordRow {
  id: bigint;
  written_by_step_execution_id: bigint;
  close_sentinel: boolean;
  real_offset: number;
  workflow_id: string;
  stream_name: string;
  body: unknown;
  created_at: Date;
}

export interface WorkflowEventRow {
  id: bigint;
  set_by_step_execution_id: bigint;
  workflow_id: string;
  event_name: string;
  created_at: Date;
}

// =============================================================================
// DATABASE OPERATIONS
// =============================================================================

export class DatabaseOperations {
  constructor(
    public readonly pool: Pool,
    public readonly schemaName: string,
  ) {}

  // =========================================================================
  // WORKFLOW OPERATIONS
  // =========================================================================

  /**
   * Create a new workflow
   * Returns true if created, false if already exists
   */
  async createWorkflow(params: {
    id: string;
    name: string;
    parentId?: string | null;
    arguments?: unknown;
    deadlineAt?: Date | null;
    completeRetentionDeadlineAt?: Date | null;
    failedRetentionDeadlineAt?: Date | null;
    cancelledRetentionDeadlineAt?: Date | null;
    killedRetentionDeadlineAt?: Date | null;
    startedByStepExecutionId?: bigint | null;
  }): Promise<{ created: boolean; workflow: WorkflowRow }> {
    const res = await this.pool.query(
      `
      INSERT INTO ${this.schemaName}.workflow (
        id, name, parent_id, arguments,
        deadline_at, complete_retention_deadline_at,
        failed_retention_deadline_at, cancelled_retention_deadline_at,
        killed_retention_deadline_at, started_by_step_execution_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (id) DO NOTHING
      RETURNING *
      `,
      [
        params.id,
        params.name,
        params.parentId ?? null,
        params.arguments ? jsonStringify(params.arguments) : null,
        params.deadlineAt ?? null,
        params.completeRetentionDeadlineAt ?? null,
        params.failedRetentionDeadlineAt ?? null,
        params.cancelledRetentionDeadlineAt ?? null,
        params.killedRetentionDeadlineAt ?? null,
        params.startedByStepExecutionId ?? null,
      ],
    );

    if (res.rowCount === 0) {
      // Already exists - fetch it
      const existing = await this.getWorkflow(params.id);
      return { created: false, workflow: existing! };
    }

    return { created: true, workflow: res.rows[0] };
  }

  /**
   * Get a workflow by ID
   */
  async getWorkflow(id: string): Promise<WorkflowRow | null> {
    const res = await this.pool.query(
      `SELECT * FROM ${this.schemaName}.workflow WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Claim a pending workflow for execution
   * Uses FOR UPDATE SKIP LOCKED to prevent races
   */
  async claimPendingWorkflow(
    executorId: string,
    workflowName?: string,
  ): Promise<WorkflowRow | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');

      // Find and lock a pending workflow
      const params: unknown[] = [executorId];
      let whereClause = "WHERE status = 'pending'";

      if (workflowName) {
        whereClause += ' AND name = $2';
        params.push(workflowName);
      }

      const selectRes = await client.query(
        `
        SELECT id FROM ${this.schemaName}.workflow
        ${whereClause}
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
        `,
        params,
      );

      if (selectRes.rowCount === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      const workflowId = selectRes.rows[0].id;

      // Claim it by setting executor_id and status
      const updateRes = await client.query(
        `
        UPDATE ${this.schemaName}.workflow
        SET status = 'running',
            executor_id = $1,
            started_at = NOW(),
            updated_at = NOW()
        WHERE id = $2
        RETURNING *
        `,
        [executorId, workflowId],
      );

      await client.query('COMMIT');
      return updateRes.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      // Handle serialization failures - let caller retry
      if (isPgError(err, PG_ERROR.SERIALIZATION_FAILURE) || isPgError(err, PG_ERROR.LOCK_NOT_AVAILABLE)) {
        return null;
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Get all workflows owned by an executor that need recovery
   */
  async getWorkflowsForRecovery(executorId: string): Promise<WorkflowRow[]> {
    const res = await this.pool.query(
      `
      SELECT * FROM ${this.schemaName}.workflow
      WHERE executor_id = $1 AND status IN ('running', 'cancelling')
      ORDER BY created_at ASC
      `,
      [executorId],
    );
    return res.rows;
  }

  /**
   * Complete a workflow successfully
   */
  async completeWorkflow(
    id: string,
    result: unknown,
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE ${this.schemaName}.workflow
      SET status = 'complete',
          result = $2,
          finished_at = NOW(),
          updated_at = NOW(),
          executor_id = NULL
      WHERE id = $1
      `,
      [id, result ? jsonStringify(result) : null],
    );
  }

  /**
   * Fail a workflow
   */
  async failWorkflow(
    id: string,
    error: unknown,
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE ${this.schemaName}.workflow
      SET status = 'failed',
          result = $2,
          finished_at = NOW(),
          updated_at = NOW(),
          executor_id = NULL
      WHERE id = $1
      `,
      [id, jsonStringify(error)],
    );
  }

  /**
   * Start cancellation of a workflow
   */
  async startCancellation(
    id: string,
    reason: 'external' | 'timeout' | 'parent_cancelled',
  ): Promise<boolean> {
    const res = await this.pool.query(
      `
      UPDATE ${this.schemaName}.workflow
      SET status = 'cancelling',
          cancellation_reason = $2,
          updated_at = NOW()
      WHERE id = $1 AND status IN ('pending', 'running')
      RETURNING id
      `,
      [id, reason],
    );
    return res.rowCount! > 0;
  }

  /**
   * Complete cancellation of a workflow
   */
  async completeCancellation(id: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE ${this.schemaName}.workflow
      SET status = 'cancelled',
          finished_at = NOW(),
          updated_at = NOW(),
          executor_id = NULL
      WHERE id = $1
      `,
      [id],
    );
  }

  /**
   * Kill a workflow immediately
   */
  async killWorkflow(id: string): Promise<boolean> {
    const res = await this.pool.query(
      `
      UPDATE ${this.schemaName}.workflow
      SET status = 'killed',
          finished_at = NOW(),
          updated_at = NOW(),
          executor_id = NULL
      WHERE id = $1 AND status NOT IN ('complete', 'failed', 'cancelled', 'killed')
      RETURNING id
      `,
      [id],
    );
    return res.rowCount! > 0;
  }

  /**
   * Check if a workflow exists
   */
  async workflowExists(id: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM ${this.schemaName}.workflow WHERE id = $1`,
      [id],
    );
    return res.rowCount! > 0;
  }

  // =========================================================================
  // STEP EXECUTION OPERATIONS
  // =========================================================================

  /**
   * Get all step executions for a workflow (for replay)
   */
  async getStepExecutions(workflowId: string): Promise<StepExecutionRow[]> {
    const res = await this.pool.query(
      `
      SELECT * FROM ${this.schemaName}.step_execution
      WHERE workflow_id = $1
      ORDER BY function_id ASC
      `,
      [workflowId],
    );
    return res.rows;
  }

  /**
   * Get a specific step execution
   */
  async getStepExecution(
    workflowId: string,
    functionId: number,
  ): Promise<StepExecutionRow | null> {
    const res = await this.pool.query(
      `
      SELECT * FROM ${this.schemaName}.step_execution
      WHERE workflow_id = $1 AND function_id = $2
      `,
      [workflowId, functionId],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Create a step execution (OAOO - returns existing if already exists)
   */
  async createStepExecution(params: {
    workflowId: string;
    functionId: number;
    functionName: string;
    actionType: ActionType;
    isFinal?: boolean;
    channelName?: string | null;
    streamName?: string | null;
    eventName?: string | null;
    sleepEndAt?: Date | null;
    sleepDuration?: string | null;
    compensationToStepExecutionId?: bigint | null;
    status?: StepStatus;
    result?: unknown;
  }): Promise<{ id: bigint; isNew: boolean; existing?: StepExecutionRow }> {
    const status = params.status ?? 'pending';
    const isFinal = params.isFinal ?? false;

    const res = await this.pool.query(
      `
      INSERT INTO ${this.schemaName}.step_execution (
        workflow_id, function_id, function_name, action_type,
        is_final, channel_name, stream_name, event_name,
        sleep_end_at, sleep_duration, compensation_to_step_execution_id,
        status, result,
        started_at, finished_at
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10, $11,
        $12, $13,
        ${status === 'running' ? 'NOW()' : 'NULL'},
        ${['complete', 'failed', 'cancelled', 'killed'].includes(status) ? 'NOW()' : 'NULL'}
      )
      ON CONFLICT (workflow_id, real_function_id) DO NOTHING
      RETURNING id
      `,
      [
        params.workflowId,
        params.functionId,
        params.functionName,
        params.actionType,
        isFinal,
        params.channelName ?? null,
        params.streamName ?? null,
        params.eventName ?? null,
        params.sleepEndAt ?? null,
        params.sleepDuration ?? null,
        params.compensationToStepExecutionId ?? null,
        status,
        params.result ? jsonStringify(params.result) : null,
      ],
    );

    if (res.rowCount === 0) {
      // Already exists - fetch it
      const existing = await this.getStepExecution(params.workflowId, params.functionId);
      return { id: existing!.id, isNew: false, existing };
    }

    return { id: BigInt(res.rows[0].id), isNew: true };
  }

  /**
   * Update step execution status to running
   */
  async startStepExecution(id: bigint, executorId: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE ${this.schemaName}.step_execution
      SET status = 'running',
          started_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      `,
      [id],
    );
  }

  /**
   * Complete a step execution
   */
  async completeStepExecution(id: bigint, result: unknown): Promise<void> {
    await this.pool.query(
      `
      UPDATE ${this.schemaName}.step_execution
      SET status = 'complete',
          result = $2,
          finished_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      `,
      [id, result ? jsonStringify(result) : null],
    );
  }

  /**
   * Fail a step execution
   */
  async failStepExecution(id: bigint, error: unknown): Promise<void> {
    await this.pool.query(
      `
      UPDATE ${this.schemaName}.step_execution
      SET status = 'failed',
          result = $2,
          finished_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      `,
      [id, jsonStringify(error)],
    );
  }

  /**
   * Cancel a step execution
   */
  async cancelStepExecution(
    id: bigint,
    reason: 'workflow_cancelled' | 'step_execution_timeout',
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE ${this.schemaName}.step_execution
      SET status = 'cancelled',
          cancellation_reason = $2,
          finished_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      `,
      [id, reason],
    );
  }

  /**
   * Get steps with compensation (for unwinding)
   * Returns in reverse order (most recent first)
   */
  async getCompensatableSteps(workflowId: string): Promise<StepExecutionRow[]> {
    const res = await this.pool.query(
      `
      SELECT * FROM ${this.schemaName}.step_execution
      WHERE workflow_id = $1
        AND action_type IN ('execute_step', 'execute_transaction')
        AND status = 'complete'
      ORDER BY function_id DESC
      `,
      [workflowId],
    );
    return res.rows;
  }

  // =========================================================================
  // STEP ATTEMPT OPERATIONS
  // =========================================================================

  /**
   * Create a step attempt
   */
  async createStepAttempt(params: {
    stepExecutionId: bigint;
    executorId: string;
    deadlineAt?: Date | null;
  }): Promise<bigint> {
    const res = await this.pool.query(
      `
      INSERT INTO ${this.schemaName}.step_execution_attempt (
        step_execution_id, executor_id, status, deadline_at,
        started_at
      ) VALUES ($1, $2, 'running', $3, NOW())
      RETURNING id
      `,
      [params.stepExecutionId, params.executorId, params.deadlineAt ?? null],
    );
    return BigInt(res.rows[0].id);
  }

  /**
   * Complete a step attempt
   */
  async completeStepAttempt(id: bigint, result: unknown): Promise<void> {
    await this.pool.query(
      `
      UPDATE ${this.schemaName}.step_execution_attempt
      SET status = 'complete',
          result = $2,
          finished_at = NOW(),
          updated_at = NOW(),
          executor_id = NULL
      WHERE id = $1
      `,
      [id, result ? jsonStringify(result) : null],
    );
  }

  /**
   * Fail a step attempt
   */
  async failStepAttempt(id: bigint, error: unknown): Promise<void> {
    await this.pool.query(
      `
      UPDATE ${this.schemaName}.step_execution_attempt
      SET status = 'failed',
          result = $2,
          finished_at = NOW(),
          updated_at = NOW(),
          executor_id = NULL
      WHERE id = $1
      `,
      [id, jsonStringify(error)],
    );
  }

  // =========================================================================
  // CHANNEL OPERATIONS
  // =========================================================================

  /**
   * Send a message to a channel
   */
  async sendChannelMessage(params: {
    destWorkflowId: string;
    channelName: string;
    body: unknown;
    sentFromWorkflow: boolean;
    sentByStepExecutionId?: bigint | null;
  }): Promise<{ ok: true } | { ok: false; reason: 'not_found' }> {
    try {
      await this.pool.query(
        `
        INSERT INTO ${this.schemaName}.channel_message (
          dest_workflow_id, channel_name, body,
          sent_from_workflow, sent_by_step_execution_id
        ) VALUES ($1, $2, $3, $4, $5)
        `,
        [
          params.destWorkflowId,
          params.channelName,
          params.body ? jsonStringify(params.body) : null,
          params.sentFromWorkflow,
          params.sentByStepExecutionId ?? null,
        ],
      );
      return { ok: true };
    } catch (err) {
      // FK violation = workflow not found
      if (isPgError(err, PG_ERROR.FOREIGN_KEY_VIOLATION)) {
        return { ok: false, reason: 'not_found' };
      }
      throw err;
    }
  }

  /**
   * Consume oldest message from a channel (atomic DELETE RETURNING)
   */
  async consumeChannelMessage(
    workflowId: string,
    channelName: string,
  ): Promise<ChannelMessageRow | null> {
    const res = await this.pool.query(
      `
      DELETE FROM ${this.schemaName}.channel_message
      WHERE id = (
        SELECT id FROM ${this.schemaName}.channel_message
        WHERE dest_workflow_id = $1 AND channel_name = $2
        ORDER BY seq_num ASC
        LIMIT 1
        FOR UPDATE
      )
      RETURNING *
      `,
      [workflowId, channelName],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Check if there's a pending message on a channel
   */
  async hasChannelMessage(
    workflowId: string,
    channelName: string,
  ): Promise<boolean> {
    const res = await this.pool.query(
      `
      SELECT 1 FROM ${this.schemaName}.channel_message
      WHERE dest_workflow_id = $1 AND channel_name = $2
      LIMIT 1
      `,
      [workflowId, channelName],
    );
    return res.rowCount! > 0;
  }

  // =========================================================================
  // STREAM OPERATIONS
  // =========================================================================

  /**
   * Write a record to a stream
   */
  async writeStreamRecord(params: {
    writtenByStepExecutionId: bigint;
    workflowId: string;
    streamName: string;
    body: unknown;
    offset: number;
  }): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO ${this.schemaName}.stream_record (
        written_by_step_execution_id, workflow_id, stream_name,
        body, real_offset, close_sentinel
      ) VALUES ($1, $2, $3, $4, $5, false)
      `,
      [
        params.writtenByStepExecutionId,
        params.workflowId,
        params.streamName,
        params.body ? jsonStringify(params.body) : null,
        params.offset,
      ],
    );
  }

  /**
   * Close a stream
   */
  async closeStream(params: {
    writtenByStepExecutionId: bigint;
    workflowId: string;
    streamName: string;
    offset: number;
  }): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO ${this.schemaName}.stream_record (
        written_by_step_execution_id, workflow_id, stream_name,
        real_offset, close_sentinel
      ) VALUES ($1, $2, $3, $4, true)
      `,
      [
        params.writtenByStepExecutionId,
        params.workflowId,
        params.streamName,
        params.offset,
      ],
    );
  }

  /**
   * Read a stream record at a specific offset
   */
  async readStreamRecord(
    workflowId: string,
    streamName: string,
    offset: number,
  ): Promise<StreamRecordRow | null> {
    const res = await this.pool.query(
      `
      SELECT * FROM ${this.schemaName}.stream_record
      WHERE workflow_id = $1 AND stream_name = $2 AND real_offset = $3
      `,
      [workflowId, streamName, offset],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Check if a stream is closed
   */
  async isStreamClosed(
    workflowId: string,
    streamName: string,
  ): Promise<boolean> {
    const res = await this.pool.query(
      `
      SELECT 1 FROM ${this.schemaName}.stream_record
      WHERE workflow_id = $1 AND stream_name = $2 AND close_sentinel = true
      `,
      [workflowId, streamName],
    );
    return res.rowCount! > 0;
  }

  /**
   * Get the next offset for a stream
   */
  async getStreamNextOffset(
    workflowId: string,
    streamName: string,
  ): Promise<number> {
    const res = await this.pool.query(
      `
      SELECT COALESCE(MAX(real_offset) + 1, 0) as next_offset
      FROM ${this.schemaName}.stream_record
      WHERE workflow_id = $1 AND stream_name = $2 AND close_sentinel = false
      `,
      [workflowId, streamName],
    );
    return parseInt(res.rows[0].next_offset, 10);
  }

  // =========================================================================
  // EVENT OPERATIONS
  // =========================================================================

  /**
   * Set an event
   */
  async setEvent(params: {
    setByStepExecutionId: bigint;
    workflowId: string;
    eventName: string;
  }): Promise<boolean> {
    try {
      await this.pool.query(
        `
        INSERT INTO ${this.schemaName}.workflow_event (
          set_by_step_execution_id, workflow_id, event_name
        ) VALUES ($1, $2, $3)
        `,
        [params.setByStepExecutionId, params.workflowId, params.eventName],
      );
      return true;
    } catch (err) {
      // Unique violation = already set
      if (isPgError(err, PG_ERROR.UNIQUE_VIOLATION)) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Check if an event is set
   */
  async isEventSet(
    workflowId: string,
    eventName: string,
  ): Promise<boolean> {
    const res = await this.pool.query(
      `
      SELECT 1 FROM ${this.schemaName}.workflow_event
      WHERE workflow_id = $1 AND event_name = $2
      `,
      [workflowId, eventName],
    );
    return res.rowCount! > 0;
  }

  // =========================================================================
  // COMPENSATION FAILURE OPERATIONS
  // =========================================================================

  /**
   * Create a compensation failure record
   */
  async createCompensationFailure(
    compensationStepExecutionId: bigint,
  ): Promise<bigint> {
    const res = await this.pool.query(
      `
      INSERT INTO ${this.schemaName}.compensation_failure (
        compensation_step_execution_id
      ) VALUES ($1)
      RETURNING id
      `,
      [compensationStepExecutionId],
    );
    return BigInt(res.rows[0].id);
  }

  /**
   * Get pending compensation failures
   */
  async getPendingCompensationFailures(): Promise<
    Array<{
      id: bigint;
      compensation_step_execution_id: bigint;
      created_at: Date;
    }>
  > {
    const res = await this.pool.query(
      `
      SELECT id, compensation_step_execution_id, created_at
      FROM ${this.schemaName}.compensation_failure
      WHERE decision = 'pending'
      ORDER BY created_at ASC
      `,
    );
    return res.rows;
  }

  /**
   * Resolve a compensation failure
   */
  async resolveCompensationFailure(
    id: bigint,
    decision: 'retry' | 'skip' | 'stop',
    comment?: string,
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE ${this.schemaName}.compensation_failure
      SET decision = $2,
          resolution_comment = $3,
          resolved_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      `,
      [id, decision, comment ?? null],
    );
  }

  // =========================================================================
  // GARBAGE COLLECTION
  // =========================================================================

  /**
   * Delete expired workflows
   */
  async deleteExpiredWorkflows(batchSize = 100): Promise<number> {
    const res = await this.pool.query(
      `
      DELETE FROM ${this.schemaName}.workflow
      WHERE id IN (
        SELECT id FROM ${this.schemaName}.workflow
        WHERE 
          (status = 'complete' AND complete_retention_deadline_at < NOW()) OR
          (status = 'failed' AND failed_retention_deadline_at < NOW()) OR
          (status = 'cancelled' AND cancelled_retention_deadline_at < NOW()) OR
          (status = 'killed' AND killed_retention_deadline_at < NOW())
        LIMIT $1
      )
      `,
      [batchSize],
    );
    return res.rowCount ?? 0;
  }

  // =========================================================================
  // TRANSACTION HELPER
  // =========================================================================

  /**
   * Run a function within a transaction
   */
  async withTransaction<T>(
    fn: (client: PoolClient) => Promise<T>,
    isolationLevel: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE' = 'READ COMMITTED',
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
