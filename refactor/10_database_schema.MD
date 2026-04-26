# 10 Database Schema

## Goal

Implement the durable schema required by the new public API: execution trees, promises, compensation block instances, request compensation, and halts.

## Source Coverage

- `REFACTOR.MD` Part 8: Database Schema.
- `REFACTOR.MD` Part 1: VEL representation.
- `REFACTOR.MD` Part 2: compensation block instances.
- `REFACTOR.MD` Part 3: halt tables.
- Request compensation tables from Part 11.

## Schema Target

- Core workflow rows track execution and compensation branch roots.
- Branch, scope, step, and promise tables represent the execution tree.
- Step rows persist serialized args and results.
- Promise rows represent awaitable operation state independently of JavaScript promises.
- Compensation block instance tables mirror the operation-bound compensation model.
- Request compensation tables represent lightweight request compensation instances.
- Halt tables represent execution, compensation block, and branch halts.
- Public status and ID types mirror database enum/check-constraint domains.

## Public API Target

- Export branded or opaque ID types for persisted workflow internals where user-facing query APIs need them.
- Export status unions for branch instances, compensation blocks, request compensation, promises, and halts.
- Query APIs should use these public types rather than ad hoc string unions.

## Affected Areas

- Migration files and migration runner.
- Runtime persistence repositories.
- `src/types/results.ts`
- `src/types/engine.ts`
- Query and handle APIs for branch, compensation, request compensation, and halt inspection.

## Acceptance Contract

The paired file `refactor/10_database_schema.ts` verifies public ID/status types and the compile-time shapes consumed by query APIs. SQL migrations should also include runtime tests or migration snapshots outside this type acceptance file.
