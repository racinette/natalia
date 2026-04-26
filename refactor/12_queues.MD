# 12 Queues

## Goal

Add global durable queues for workflow-produced work and client-registered handlers.

## Source Coverage

- `REFACTOR.MD` Part 10: Queues.
- `REFACTOR.MD` Part 16: Scheduled Delivery.
- `REFACTOR.MD` Part 15 and 15b: attempt access and `UnrecoverableError`.
- Search query generalization for dead-letter APIs.

## Public API Target

- Export `defineQueue`.
- Workflows declare queues and enqueue messages through `ctx.queues.X.enqueue(payload, opts?)`.
- Enqueue is a synchronous buffered workflow operation.
- Queue options include TTL, priority, delay, and scheduled delivery.
- Client APIs register one active handler per queue where appropriate.
- Handler callbacks receive `{ signal }` and decoded messages.
- Handler retry policies use durable seconds-based fields.
- Exhausted messages move to dead letter storage.
- Dead-letter client APIs can search, inspect, retry, and purge messages.

## Runtime Target

- Queue records persist payload, metadata, priority, scheduled availability, attempts, and dead-letter state.
- Handlers record attempt history through `AttemptAccessor`.
- `UnrecoverableError` bypasses remaining retries and dead-letters immediately.

## Affected Areas

- New queue definition and client modules.
- `src/types/definitions.ts`
- `src/types/context.ts`
- `src/types/engine.ts`
- Migrations and queue worker runtime.

## Acceptance Contract

The paired file `refactor/12_queues.ts` verifies definition inference, workflow enqueue typing, scheduling option exclusivity, handler typing, dead-letter query typing, and immediate-exhaustion behavior surface.
