// =============================================================================
// INTERNAL RUNTIME ERROR CLASSES
//
// Pre-step-04 error classes (`WorkflowError`, `WorkflowCancelledError`,
// `WorkflowKilledError`, `StepCancelledError`, `MaxRetriesExceededError`,
// `WorkflowConflictError`, `WorkflowNotFoundError`, `NonDeterminismError`,
// `StepTimeoutError`, `CompensationFailedError`) have been removed from the
// public API. The new error model uses `ExplicitError` for declared
// business failures (`ctx.errors.X(...)`), `AttemptError` for handler-side
// retried-operation failures, and the operator-action verbs (`sigkill` /
// `sigterm` / `skip`) for terminal control. See REFACTOR.MD Part 4 / 9 / 15.
//
// `EngineShutdownError` is retained as a runtime-only error thrown by the
// engine entrypoint when it has been shut down.
// =============================================================================

/**
 * Thrown when trying to operate on a shutdown engine.
 */
export class EngineShutdownError extends Error {
  constructor() {
    super("WorkflowEngine is shutdown");
    this.name = "EngineShutdownError";
  }
}
