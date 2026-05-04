/**
 * Durable Workflow Engine
 *
 * A type-safe, Postgres-backed, actor-model durable execution engine.
 *
 * The public API in this package is in active redesign — see REFACTOR.MD at
 * the repository root for the authoritative spec. The notes below describe
 * the surface as it stands today; comments in individual modules carry the
 * up-to-date semantics.
 *
 * ## Core Concepts
 *
 * - Workflows: long-running, durable processes with a single sequential body
 *   that orchestrates concurrent dispatched entries (steps, requests, attached
 *   child workflows).
 * - Scopes: structured-concurrency boundary. `ctx.scope(name, entries, body)`
 *   dispatches a top-level object of entries and runs the body with handles.
 * - Convenience helpers: `ctx.all`, `ctx.first`, `ctx.atLeast`, `ctx.atMost`,
 *   `ctx.some` — each takes a scope name and a top-level entry object.
 * - Steps: durable, retriable operations. `ctx.steps.X(args, opts?)` returns
 *   an awaitable entry; `{ timeout }` adds a timeout variant to the result.
 * - Requests: typed request-response delegated to a registered handler or
 *   resolved manually.
 * - Child workflows: `ctx.childWorkflows.X(startOpts, opts?)` for attached
 *   children (lifecycle bound to parent), `.startDetached(opts)` for detached
 *   starts. Foreign workflows are addressable via `ctx.foreignWorkflows.X.get`.
 * - Channels / streams / events / attributes: per-instance primitives,
 *   inbound, outbound, write-once, observable single value respectively.
 * - Compensation: declared on the step or request that owns the action; each
 *   invocation is a queryable per-instance compensation block.
 * - Errors: `defineWorkflow.errors` declares typed business failures; throw
 *   them with `ctx.errors.X(message, details?)`. The body fails with a typed
 *   `ErrorValue` visible to external callers.
 */

// Public API - Types
export * from "./types";

// Public API - Definition helpers
export {
  defineQueue,
  defineRequest,
  defineStep,
  defineTopic,
  defineWorkflow,
  defineWorkflowHeader,
  MANUAL,
  registerRequestCompensationHandler,
} from "./workflow";

// Public API - Engine
export { WorkflowEngine, type WorkflowEngineConfig } from "./engine";

// Public API - Client
export { createWorkflowClient } from "./client";

// Public API - Engine errors
//
// User-facing error vocabulary lives in `./types/results`:
//   - `ExplicitError` (thrown via `ctx.errors.X(message, details?)`)
//   - `AttemptError` (handler-side structured failure)
//
// Engine runtime errors (currently only `EngineShutdownError`) live here.
export { EngineShutdownError } from "./internal/errors";
