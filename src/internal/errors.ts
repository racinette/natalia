// =============================================================================
// CUSTOM ERROR TYPES
// =============================================================================

/**
 * Base error class for workflow errors
 */
export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

/**
 * Thrown when a workflow is cancelled
 */
export class WorkflowCancelledError extends WorkflowError {
  constructor(
    public readonly workflowId: string,
    public readonly reason: CancellationReasonInternal,
  ) {
    super(`Workflow ${workflowId} was cancelled: ${reason.type}`);
    this.name = "WorkflowCancelledError";
  }
}

/**
 * Internal representation of cancellation reason
 */
export type CancellationReasonInternal =
  | { type: "external"; data: unknown }
  | { type: "timeout" }
  | { type: "parent_cancelled" };

/**
 * Thrown when a workflow is killed
 */
export class WorkflowKilledError extends WorkflowError {
  constructor(public readonly workflowId: string) {
    super(`Workflow ${workflowId} was killed`);
    this.name = "WorkflowKilledError";
  }
}

/**
 * Thrown when a step execution is cancelled
 */
export class StepCancelledError extends WorkflowError {
  constructor(
    public readonly functionId: number,
    public readonly reason: "workflow_cancelled" | "step_execution_timeout",
  ) {
    super(`Step ${functionId} was cancelled: ${reason}`);
    this.name = "StepCancelledError";
  }
}

/**
 * Thrown when maximum retry attempts are exceeded
 */
export class MaxRetriesExceededError extends WorkflowError {
  constructor(
    public readonly stepName: string,
    public readonly attempts: number,
    public readonly lastError: Error,
  ) {
    super(
      `Step ${stepName} failed after ${attempts} attempts: ${lastError.message}`,
    );
    this.name = "MaxRetriesExceededError";
    this.cause = lastError;
  }
}

/**
 * Thrown when there's a conflict during workflow execution
 */
export class WorkflowConflictError extends WorkflowError {
  constructor(
    public readonly workflowId: string,
    message: string,
  ) {
    super(`Conflict in workflow ${workflowId}: ${message}`);
    this.name = "WorkflowConflictError";
  }
}

/**
 * Thrown when a workflow is not found
 */
export class WorkflowNotFoundError extends WorkflowError {
  constructor(public readonly workflowId: string) {
    super(`Workflow ${workflowId} not found`);
    this.name = "WorkflowNotFoundError";
  }
}

/**
 * Thrown when workflow replay detects a non-determinism issue
 */
export class NonDeterminismError extends WorkflowError {
  constructor(
    public readonly workflowId: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `Non-determinism detected in workflow ${workflowId}: ` +
        `expected ${expected}, got ${actual}`,
    );
    this.name = "NonDeterminismError";
  }
}

/**
 * Thrown when a step timeout occurs
 */
export class StepTimeoutError extends WorkflowError {
  constructor(
    public readonly stepName: string,
    public readonly timeoutSeconds: number,
  ) {
    super(`Step ${stepName} timed out after ${timeoutSeconds} seconds`);
    this.name = "StepTimeoutError";
  }
}

/**
 * Thrown when trying to operate on a shutdown engine
 */
export class EngineShutdownError extends Error {
  constructor() {
    super("WorkflowEngine is shutdown");
    this.name = "EngineShutdownError";
  }
}

/**
 * Thrown when compensation fails and needs manual resolution
 */
export class CompensationFailedError extends WorkflowError {
  constructor(
    public readonly compensationStepExecutionId: bigint,
    public readonly stepName: string,
    public readonly lastError: Error,
  ) {
    super(`Compensation for step ${stepName} failed: ${lastError.message}`);
    this.name = "CompensationFailedError";
    this.cause = lastError;
  }
}
