# 01 Virtual Event Loop And Entries

## Goal

Implement the execution model described in `REFACTOR.MD` Part 1 and the entry model implied by Part 5. Natalia should expose small awaitable entries as the public workflow API, while the engine records and schedules work through the virtual event loop (VEL).

## Source Coverage

- `REFACTOR.MD` Part 1: Virtual Event Loop.
- `REFACTOR.MD` Part 5: awaitable entry sketches and removed call types.
- `REFACTOR.MD` summary: removed `DurableHandle`, `AtomicResult`, call builders, and `.resolve(ctx)`.

## Public API Target

- Workflow operations return opaque awaitable entries, not native promises and not `DurableHandle`.
- Entries can be directly awaited or consumed by structured-concurrency APIs.
- `.resolve(ctx)` disappears from the public surface.
- Builder-chain types disappear from public exports: `StepCall`, `WorkflowCall`, `RequestCall`, `ScopeCall`, `FirstCall`, `Called`, `TFail`, and `TTimeout`.
- Buffered operations remain synchronous public calls and are committed by the engine in batched transactions.
- Awaitable reads flush buffered operations before observing committed state.

## Runtime Target

- Each workflow instance owns two VEL roots: execution and compensation.
- The VEL persists logical promises and schedules runnable work without relying on JavaScript promise scheduling.
- Branch interleaving order is implementation-defined and must not affect observable workflow correctness.
- Nested scopes record scope and branch ancestry explicitly.
- The execution tree records branch, scope, step, and promise state enough to replay deterministically.

## Affected Areas

- `src/types/context.ts`
- `src/types/definitions.ts`
- `src/types/results.ts`
- `src/types/engine.ts`
- `src/types.ts`
- `src/index.ts`
- Runtime VEL, replay, and persistence modules that materialize branches, scopes, steps, and promises.

## Acceptance Contract

The paired file `refactor/01_virtual_event_loop_and_entries.ts` is the compile-time acceptance contract. It must prove that the public API exposes awaitable entries without `.resolve(ctx)` and no longer exports the old handle/call-builder types.

Runtime implementation should also add unit or integration coverage for VEL replay, buffer flushing before reads, nested scopes, and branch order independence.
