# 09 Halt Model

## Goal

Formalize execution, compensation, and branch halts as durable operator-visible states with clear throw rules and resolution paths.

## Source Coverage

- `REFACTOR.MD` Part 3: Halt Model.
- `REFACTOR.MD` Part 8: halt tables.
- Compensation and branch sections that allow skippable halted instances.

## Public API Target

- Execution halts stop workflow progress until patch-and-replay or termination.
- Compensation halts stop a specific compensation block and can be skipped per instance.
- Branch halts stop branch progress and can be observed by the owning structured-concurrency consumer.
- Context APIs expose typed halt-aware statuses where user code can observe them.
- Throw rules differ by context and align with workflow, branch, and compensation lifecycle boundaries.

## Runtime Target

- Halts are persisted with enough information for operator inspection.
- Replaying after a code patch can clear execution halts.
- Skipping a compensation or branch halt is an explicit operator action.
- Halt state does not silently become a generic JavaScript exception.

## Affected Areas

- `src/types/results.ts`
- `src/types/context.ts`
- `src/types/engine.ts`
- Runtime error handling and operator APIs.
- Halt persistence tables.

## Acceptance Contract

The paired file `refactor/09_halt_model.ts` verifies public halt status unions, skip APIs for skippable contexts, and rejection of skip operations where halts are not skippable.
