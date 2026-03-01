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
 * - BranchHandle: Awaitable handle produced by scope entries — passed to select/map
 * - Compensation: Registered per-step via .compensate(cb) builder, runs LIFO on failure.
 *     Compensation always runs if any attempt was made — the engine assumes at-least-once
 *     semantics for external side effects. No status checks needed in callbacks.
 *     addCompensation(cb) provides general-purpose cleanup.
 * - BranchFailureInfo: Passed to failure callbacks in map/match for branch handles.
 *     claimCompensation() — transfer ownership and receive a callable compensation runner.
 *     Once claimed, the engine will not run that compensation automatically.
 * - failure/complete builders: { complete, failure } callbacks on concurrency primitives
 *     (match, map) for explicit failure recovery on branch handles.
 * - Select: `ctx.select(handles)` returns a Selection<M>.
 *     `for await...of` — primary iteration surface; yields SelectDataUnion<M> (successful data
 *     from all handle types including channels and receive calls); branch failure auto-terminates.
 *     `.match(handlers)` — key-aware single-event dispatch; supports { complete, failure }
 *     handlers on branch handle keys for granular recovery without auto-termination.
 *     No `.next()` method — use `for await` for simple iteration, `.match()` for granular control.
 *     Channel inputs: raw ChannelHandle = streaming (never exhausted); ChannelReceiveCall = one-shot.
 * - map: Batch transformation of FiniteHandle inputs with { complete, failure } handlers.
 *     Accepts BranchHandle variants and ChannelReceiveCall (not raw ChannelHandle).
 *     Collection handles (BranchHandle[], Map<K, BranchHandle>) pass innerKey to callbacks.
 * - Child workflows: ctx.childWorkflows.* — structured invocation (WorkflowCall<T> thenable).
 *     Supports .compensate(), .failure(), .complete() in result mode.
 *     Use call option `{ detached: true }` for fire-and-forget messaging mode
 *     which returns a ForeignWorkflowHandle directly.
 * - Foreign workflows: ctx.foreignWorkflows.* — message-only handles to existing instances.
 *     Only channels.send() is available — no lifecycle coupling.
 * - Channels: Async message passing (input).
 *     ctx.channels.receive() returns ChannelReceiveCall<T> — awaitable directly or passed into
 *     select/map for one-shot channel waits. Timeout overloads available:
 *     receive(timeoutSeconds) → T | undefined; receive(timeoutSeconds, defaultValue) → T | TDefault.
 *     receive(0) is a deterministic nowait poll.
 *     Raw ChannelHandle can be passed into select for streaming (multi-message) branches.
 * - Streams: Append-only logs (output)
 * - Events: Write-once coordination flags with "never" semantics
 * - Lifecycle Events: Engine-managed workflow state signals (external API only)
 * - Signals: sigterm (graceful) / sigkill (immediate) — engine-level only
 * - CompensationContext: Full structured concurrency with explicit failure visibility;
 *     step calls resolve to CompensationStepResult<T> (must handle ok/!ok gracefully).
 *     No addCompensation() (no nested compensation chains).
 */

// Public API - Types
export * from "./types";

// Public API - Definition helpers
export { defineStep, defineWorkflow, defineWorkflowHeader } from "./workflow";

// Public API - Engine
export { WorkflowEngine, type WorkflowEngineConfig } from "./engine";

// Public API - Migrations
export {
  runMigrations,
  getCurrentVersion,
  MigrationError,
  MigrationRaceError,
  MigrationChecksumMismatchError,
  type Migration,
  type MigrationResult,
} from "./migrations/runner";

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
} from "./internal/errors";
