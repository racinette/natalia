/**
 * Durable Workflow Engine
 *
 * A type-safe, Postgres-backed, actor-model durable execution engine.
 *
 * Core concepts:
 * - Workflows: Long-running, durable processes with happy-path-only code
 * - Steps: Durable, retriable operations — calling a step returns a StepCall<T> thenable.
 *     Chain builders before awaiting: .compensate(cb), .retry(policy), .failure(cb), .complete(cb)
 * - Scopes: Structured concurrency — concurrent branches run as closures inside ctx.scope().
 *     Collections (Array, Map) are supported for dynamic fan-out.
 * - BranchHandle: Awaitable handle produced by scope entries — passed to select/forEach/map
 * - Compensation: Registered per-step via .compensate(cb) builder, runs LIFO on failure.
 *     addCompensation(cb) provides general-purpose cleanup.
 * - failure/complete builders: { complete, failure } callbacks on concurrency primitives
 *     (match, forEach, map) for explicit failure recovery. failure() receives BranchFailureInfo
 *     with compensate() for eager discharge when compensation was registered.
 * - Child workflows: ctx.childWorkflows.* — structured invocation (WorkflowCall<T> thenable).
 *     Supports .compensate(), .failure(), .complete() (result mode) or .detached() (messaging mode).
 * - Foreign workflows: ctx.foreignWorkflows.* — message-only handles to existing instances.
 * - Channels: Async message passing (input)
 * - Streams: Append-only logs (output)
 * - Events: Write-once coordination flags with "never" semantics
 * - Lifecycle Events: Engine-managed workflow state signals
 * - Select: Concurrency primitive for multiplexing handles (.next, .match, async iteration)
 * - forEach / map: Batch processing with { complete, failure } handlers; collection-aware
 * - Signals: sigterm (graceful) / sigkill (immediate) — engine-level only
 * - CompensationContext: Full structured concurrency with explicit failure visibility;
 *     step calls resolve to CompensationStepResult<T> (must handle ok/!ok gracefully)
 */

// Public API - Types
export * from './types';

// Public API - Definition helpers
export { defineStep, defineWorkflow } from './workflow';

// Public API - Engine
export { WorkflowEngine, type WorkflowEngineConfig } from './engine';

// Public API - Migrations
export {
  runMigrations,
  getCurrentVersion,
  MigrationError,
  MigrationRaceError,
  MigrationChecksumMismatchError,
  type Migration,
  type MigrationResult,
} from './migrations/runner';

// Public API - Errors (for catch blocks)
export {
  WorkflowError,
  WorkflowCancelledError,
  WorkflowKilledError,
  StepCancelledError,
  MaxRetriesExceededError,
  WorkflowConflictError,
  WorkflowNotFoundError,
  NonDeterminismError,
  StepTimeoutError,
  EngineShutdownError,
  CompensationFailedError,
} from './internal/errors';
