# 12 Queues

## Goal

Add global durable queues for workflow-produced work and client-registered handlers.

## Source Coverage

- `REFACTOR.MD` Part 10: Queues.
- `REFACTOR.MD` Part 16: Scheduled Delivery.
- `REFACTOR.MD` Part 15 and 15b: attempt access and `DEAD_LETTER`.
- Search query generalization for dead-letter APIs.

## Public API Target

- Export `defineQueue`.
- Workflows declare queues and enqueue messages through `ctx.queues.<slot>.enqueue(payload, opts?)`.
- Enqueue is a synchronous buffered workflow operation (no `txOrConn`).
- Queue options include TTL, priority, delay, and scheduled delivery (`ScheduledDeliveryOptions`).
- Client queue namespaces are keyed by **queue definition name** (not workflow-local slot names):
  `client.queues.<queueDefinitionName>.registerHandler(...)`.
- Handler callbacks receive decoded messages and opts (`{ signal }`).
- Handler retry policies use durable seconds-based fields.
- Handler registration does not accept `txOrConn`; the runtime owns worker connection/transaction management.
- Exhausted messages move to dead letter storage.
- Dead-letter client APIs use the unified namespace/handle model:
  `client.queues.<name>.deadLetters.findMany` / `findUnique` / `count` / `get(id)`.
- Dead-letter search returns handles; `retry`, `purge`, and `fetchRow` are handle methods.
- Client/operator dead-letter query and action IO accepts optional `txOrConn?`.

## Runtime Target

- Queue records persist payload, metadata, priority, scheduled availability, attempts, and dead-letter state.
- Handlers record attempt history through `AttemptAccessor`.
- `DEAD_LETTER` bypasses remaining retries and dead-letters immediately.

## Affected Areas

- New queue definition and client modules.
- `src/types/definitions.ts`
- `src/types/context.ts`
- `src/types/engine.ts`
- Migrations and queue worker runtime.

## Acceptance Contract

The paired file `src/types-regression-tests/13_queues.ts` verifies definition inference, workflow enqueue typing, scheduling option exclusivity, namespace-based handler registration, dead-letter namespace/handle typing, `txOrConn?` placement, and immediate-exhaustion behavior surface.
