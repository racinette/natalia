/**
 * Durable Workflow Engine
 *
 * A type-safe, Postgres-backed, actor-model durable execution engine.
 *
 * ## Awaitable Tier Hierarchy
 *
 * Primitives are split into three tiers based on whether and how they can be awaited:
 *
 * **Tier 1 — Execute/join-only (`DeterministicAwaitable<T, TRoot>`):**
 * Steps, child workflows, scope/all/first results, and BranchHandles.
 * NOT directly awaitable — must be resolved via `ctx.execute()` or `ctx.join()`.
 * Enforces at compile time that BranchHandle scope paths are accessible from the current
 * scope, and that execution-root handles cannot be resolved from CompensationContext.
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
 *     Chain builders before executing: .compensate(cb), .retry(policy), .failure(cb), .complete(cb)
 *     Resolve via: `await ctx.execute(ctx.steps.myStep(args))`
 *
 * - ctx.execute(handle): Resolves a lazy Tier-1 DeterministicAwaitable.
 *     Available on ALL contexts (WorkflowContext, CompensationContext,
 *     WorkflowConcurrencyContext, CompensationConcurrencyContext).
 *     Use for steps, child workflows, scope(), all(), first() results.
 *     Execution-context handles cannot be executed from CompensationContext, and vice versa.
 *
 * - ctx.join(handle): Resolves an already-running BranchHandle.
 *     Available ONLY on concurrency contexts (WorkflowConcurrencyContext,
 *     CompensationConcurrencyContext). Enforces at compile time that the
 *     handle's scope path is a prefix of the current scope path.
 *     Use ctx.execute() for lazy handles (steps, child workflows), not ctx.join().
 *
 * - Scopes: Structured concurrency — concurrent branches run as closures inside
 *     ctx.scope(scopeName, entries, callback).
 *     Entries are closure-only: `(ctx: WorkflowContext<..., BranchPath>) => Promise<T>`.
 *     Each `ctx` is a path-specialized base context (WorkflowContext or CompensationContext)
 *     with scope path `AppendBranchKey<AppendScopeName<ParentPath, Name>, K>`.
 *     This enables compile-time tracking of which branches created which nested scope handles.
 *     Fan-out: use `ctx.execute(ctx.all({...}))` inside closures.
 *     scope() ALWAYS returns DeterministicAwaitable<R, Root> on all contexts.
 *     Resolve: `await ctx.execute(ctx.scope("Name", entries, callback))`
 *
 * - BranchHandle: Opaque handle produced by scope entries — passed to select() or resolved
 *     via ctx.join() inside the scope callback.
 *     BranchHandle<T, TScopePath, TRoot>: scope path enforces lifetime; TRoot enforces context boundary.
 *
 * - Scope path symbol system: `ScopeDivider` and `BranchDivider` symbols are inserted into
 *     scope paths at scope-name and branch-key transitions respectively, making the two
 *     structurally unambiguous at both type level and runtime.
 *     Example path: `[scopeDivider, "BookFlight", branchDivider, "passport"]`
 *
 * - Compensation: Registered per-step via .compensate(cb) builder, runs LIFO on failure.
 *     Compensation always runs if any attempt was made — the engine assumes at-least-once
 *     semantics for external side effects. No status checks needed in callbacks.
 *     addCompensation(cb) provides general-purpose cleanup.
 * - BranchFailureInfo: Passed to failure callbacks in match for branch handles.
 * - failure/complete builders: { complete, failure } callbacks on match for explicit
 *     failure recovery on branch handles.
 *
 * - ctx.listen(handles): Channel-only multiplexed waiting. Available on ALL contexts.
 *     Returns Listener<M> — directly iterable: `for await (const { key, message } of listener)`.
 *     Accepts only ChannelHandle and ChannelReceiveCall (no branch handles).
 *     ChannelHandle = streaming (never exhausted); ChannelReceiveCall = one-shot.
 *
 * - ctx.select(handles): Branch + channel multiplexing. Available ONLY on concurrency contexts.
 *     Returns Selection<M> (or CompensationSelection<M>) — consume via ctx.match(sel, ...).
 *     Accepts BranchHandle, ChannelHandle, and ChannelReceiveCall.
 *
 * - ctx.match(sel, ...): Key-aware async iteration over a Selection. Concurrency contexts only.
 *     Four overloads:
 *     - match(sel) → `AsyncIterable<{ key, result }>` — no handlers, yields keyed union.
 *     - match(sel, onFailure) → yields with default failure callback.
 *     - match(sel, handlers) → per-key handlers; unhandled keys yield data unchanged (identity).
 *     - match(sel, handlers, onFailure) → per-key handlers + default failure callback.
 *     Handler forms for BranchHandle keys: plain function | { complete, failure } | { complete } | { failure }.
 *     Channel inputs: ChannelHandle = streaming; ChannelReceiveCall = one-shot.
 *
 * - all: `ctx.all(entries)` for "run all and collect results".
 *     Entries are closure-only: each is `(ctx) => Promise<T>`.
 *     Resolve: `await ctx.execute(ctx.all(entries))`.
 *
 * - first: `ctx.first(entries)` for "run all, return the first to complete".
 *     Entries are closure-only. Returns `DeterministicAwaitable<{ key, result }>`.
 *     Resolve: `await ctx.execute(ctx.first(entries))` → `{ key: K; result: T }`.
 *
 * - Child workflows: ctx.childWorkflows.* — structured invocation (WorkflowCall<T> opaque handle).
 *     Supports .compensate(), .failure(), .complete() in result mode.
 *     Resolve via: `await ctx.execute(ctx.childWorkflows.myWorkflow(opts).complete(cb))`.
 *     Use `.startDetached(opts)` for fire-and-forget start — returns `DirectAwaitable<ForeignWorkflowHandle>`,
 *     directly awaitable: `const handle = await ctx.childWorkflows.myWorkflow.startDetached(opts)`.
 * - Foreign workflows: ctx.foreignWorkflows.* — message-only handles to existing instances.
 *     Only channels.send() is available — no lifecycle coupling.
 *     Directly awaitable: `await existing.channels.nudge.send(msg)`.
 * - Channels: Async message passing (input).
 *     `ctx.channels.X.receive()` returns a directly awaitable `ChannelReceiveCall<T>`.
 *     Can also be passed into `select`/`listen` for channel waits.
 *     Timeout overloads: `receive(timeoutSeconds) → T | undefined`, `receive(timeoutSeconds, default) → T | TDefault`.
 *     `receiveNowait()` — atomic non-blocking poll (Tier 3, NOT a scope entry):
 *     `await ctx.channels.X.receiveNowait()` or `receiveNowait(defaultValue)`.
 *     Raw ChannelHandle can be passed into select/listen for streaming (multi-message) branches.
 * - Streams: Append-only logs (output). Directly awaitable: `await ctx.streams.myStream.write(data)`.
 * - Events: Write-once coordination flags. Directly awaitable: `await ctx.events.myEvent.set()`.
 * - Patches: Safe workflow code evolution. Directly awaitable: `if (await ctx.patches.myPatch) { ... }`.
 * - Lifecycle Events: Engine-managed workflow state signals (external API only)
 * - Signals: sigterm (graceful) / sigkill (immediate) — engine-level only
 * - CompensationContext: Full structured concurrency with explicit failure visibility;
 *     step calls resolve to CompensationStepResult<T> (must handle ok/!ok gracefully).
 *     No addCompensation() (no nested compensation chains).
 *     Handles are CompensationRoot-branded — cannot be executed from execution context.
 *     Concurrency context is CompensationConcurrencyContext (no WorkflowCompensation prefix).
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
