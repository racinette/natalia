/**
 * Durable Workflow Engine
 *
 * A type-safe, Postgres-backed, actor-model durable execution engine.
 *
 * Core concepts:
 * - Workflows: Long-running, durable processes with happy-path-only code
 * - Steps: Durable, retriable operations — .execute() returns T directly
 * - Scopes: Structured concurrency — all concurrent handles live in scopes
 * - Compensation: One callback per handle at .start()/.execute() time, LIFO unwinding
 * - onFailure: Unified single-param failure handling — { onComplete, onFailure } callbacks
 *     on concurrency primitives (match, forEach, map) AND sequential ops (tryExecute, tryJoin).
 *     Receives a flat failure object with compensate() merged in when compensation was registered.
 * - compensate(): Eager discharge inside onFailure — switches to compensation mode (SIGTERM-resilient)
 * - Channels: Async message passing (input)
 * - Streams: Append-only logs (output)
 * - Events: Write-once coordination flags with "never" semantics
 * - Lifecycle Events: Engine-managed workflow state signals
 * - Select: Concurrency primitive for multiplexing handles (.next, .match, async iteration)
 * - forEach / map: One-shot batch processing with { onComplete, onFailure } handlers
 * - Signals: sigterm (graceful) / sigkill (immediate) — engine-level only
 * - CompensationContext: Full structured concurrency with explicit failure visibility
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
