/**
 * Durable Workflow Engine
 *
 * A type-safe, Postgres-backed, actor-model durable execution engine.
 *
 * ## Awaitable Tier Hierarchy
 *
 * Primitives are split into three tiers based on whether and how they can be awaited:
 *
 * **Tier 1 — Join-only (`DeterministicAwaitable<T, TRoot>`):**
 * Steps, child workflows, scope/map/all results, and BranchHandles.
 * NOT directly awaitable — must be resolved via `await ctx.join(handle)`.
 * Enforces at compile time that BranchHandle scope paths are accessible from the current
 * scope, and that execution-root handles cannot be joined from CompensationContext.
 *
 * **Tier 2 — Directly awaitable + valid scope entry (`WorkflowAwaitable<T>`):**
 * Blocking async operations: `ctx.sleep()`, `ctx.sleepUntil()`, `ctx.channels.X.receive()`,
 * `scheduleHandle.sleep()`, `lifecycleEvent.wait()`.
 * Can be `await`-ed directly OR passed as a scope entry to `ctx.scope()` / `ctx.all()`.
 *
 * **Tier 3 — Directly awaitable, NOT a scope entry (`DirectAwaitable<T>`):**
 * Atomic operations synchronous at the engine level:
 * `ctx.streams.X.write()`, `ctx.events.X.set()`, `ctx.patches.X`,
 * `foreignHandle.channels.X.send()`, `ctx.channels.X.receiveNowait()`,
 * `ctx.childWorkflows.X.startDetached()`, `lifecycleEvent.get()`.
 *
 * ## Core Concepts
 *
 * - Workflows: Long-running, durable processes with happy-path-only code
 * - Steps: Durable, retriable operations — calling a step returns a StepCall<T> opaque handle.
 *     Chain builders before joining: .compensate(cb), .retry(policy), .failure(cb), .complete(cb)
 *     Resolve via: `await ctx.join(ctx.steps.myStep(args))`
 * - ctx.join(handle): The ONLY way to resolve a Tier-1 DeterministicAwaitable or BranchHandle.
 *     Enforces at compile time that BranchHandle scope paths are accessible from the current scope.
 *     Execution-context handles cannot be joined from CompensationContext, and vice versa.
 * - Scopes: Structured concurrency — concurrent branches run as closures inside
 *     ctx.scope(scopeName, entries, callback).
 *     Collections (Array, Map) are supported for dynamic fan-out.
 *     Resolve the scope result: `await ctx.join(ctx.scope("Name", entries, callback))`
 * - BranchHandle: Opaque handle produced by scope entries — passed to select/map or resolved via ctx.join().
 *     BranchHandle<T, TScopePath, TRoot>: scope path enforces lifetime; TRoot enforces context boundary.
 * - Compensation: Registered per-step via .compensate(cb) builder, runs LIFO on failure.
 *     Compensation always runs if any attempt was made — the engine assumes at-least-once
 *     semantics for external side effects. No status checks needed in callbacks.
 *     addCompensation(cb) provides general-purpose cleanup.
 * - BranchFailureInfo: Passed to failure callbacks in map/match for branch handles.
 * - failure/complete builders: { complete, failure } callbacks on concurrency primitives
 *     (match, map) for explicit failure recovery on branch handles.
 * - Select: base `ctx.select(handles)` is channel-only.
 *     Full branch-aware select is available on the scope callback context.
 *     `for await...of` — primary iteration surface; yields SelectDataUnion<M> (successful data
 *     from all handle types including channels and receive calls); branch failure auto-terminates.
 *     `.match(handlers, onFailure?)` — key-aware async iteration; `for await (const val of sel.match(...))`.
 *     Handlers can be plain functions, { complete, failure }, { complete }, or { failure } (identity for complete).
 *     Omitting a key yields its data unchanged (identity) on complete; failure auto-terminates (or uses onFailure).
 *     onFailure: default failure callback for keys without an explicit failure handler.
 *     Channel inputs: raw ChannelHandle = streaming (never exhausted); ChannelReceiveCall = one-shot.
 * - map: Scope-local primitive only (not on base workflow/compensation contexts).
 *     Use inside `ctx.scope("Name", entries, async (ctx, handles) => ...)`.
 *     Resolve via: `await ctx.join(ctx.map(handles, callbacks?, onFailure?))`.
 *     map(handles) — identity for all, failure terminates.
 *     map(handles, callbacks, onFailure?) — partial per-key handlers + optional default failure callback.
 *     Accepts BranchHandle variants and ChannelReceiveCall (not raw ChannelHandle).
 *     Collection handles (BranchHandle[], Map<K, BranchHandle>) pass innerKey to callbacks.
 * - all: `ctx.all(entries)` sugar for the common "join all and collect results" pattern.
 *     Resolve via: `await ctx.join(ctx.all(entries))`.
 *     Preserves input shape (single/array/map) and follows normal failure semantics.
 * - Child workflows: ctx.childWorkflows.* — structured invocation (WorkflowCall<T> opaque handle).
 *     Supports .compensate(), .failure(), .complete() in result mode.
 *     Resolve via: `await ctx.join(ctx.childWorkflows.myWorkflow(opts).complete(cb))`.
 *     Use `.startDetached(opts)` for fire-and-forget start — returns `DirectAwaitable<ForeignWorkflowHandle>`,
 *     directly awaitable: `const handle = await ctx.childWorkflows.myWorkflow.startDetached(opts)`.
 * - Foreign workflows: ctx.foreignWorkflows.* — message-only handles to existing instances.
 *     Only channels.send() is available — no lifecycle coupling.
 *     Directly awaitable: `await existing.channels.nudge.send(msg)`.
 * - Channels: Async message passing (input).
 *     `ctx.channels.X.receive()` returns a directly awaitable `ChannelReceiveCall<T>`.
 *     Can also be passed into `select`/`map` for one-shot channel waits.
 *     Timeout overloads: `receive(timeoutSeconds) → T | undefined`, `receive(timeoutSeconds, default) → T | TDefault`.
 *     `receiveNowait()` — atomic non-blocking poll (Tier 3, NOT a scope entry):
 *     `await ctx.channels.X.receiveNowait()` or `receiveNowait(defaultValue)`.
 *     Raw ChannelHandle can be passed into select for streaming (multi-message) branches.
 * - Streams: Append-only logs (output). Directly awaitable: `await ctx.streams.myStream.write(data)`.
 * - Events: Write-once coordination flags. Directly awaitable: `await ctx.events.myEvent.set()`.
 * - Patches: Safe workflow code evolution. Directly awaitable: `if (await ctx.patches.myPatch) { ... }`.
 * - Lifecycle Events: Engine-managed workflow state signals (external API only)
 * - Signals: sigterm (graceful) / sigkill (immediate) — engine-level only
 * - CompensationContext: Full structured concurrency with explicit failure visibility;
 *     step calls resolve to CompensationStepResult<T> (must handle ok/!ok gracefully).
 *     No addCompensation() (no nested compensation chains).
 *     Handles are CompensationRoot-branded — cannot be joined from execution context.
 */

// Public API - Types
export * from "./types";

// Public API - Definition helpers
export { defineStep, defineWorkflow, defineWorkflowHeader } from "./workflow";

// Public API - Engine
export { WorkflowEngine, type WorkflowEngineConfig } from "./engine";

// Public API - Client
export { createWorkflowClient } from "./client";

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
