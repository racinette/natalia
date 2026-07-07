# 13 Queues

## Goal

Implement global durable queues per [docs/primitives/queues.md](../docs/primitives/queues.md).

## Source Coverage

- [docs/primitives/queues.md](../docs/primitives/queues.md) — authoritative public API and semantics (types + operator surface; runtime deferred).
- [docs/error-model.md](../docs/error-model.md) — queue handler `ctx.errors` vs workflow `ctx.errors`; retention on registration plane.
- Search query generalization for dead-letter APIs.

## Public API Target

See [docs/primitives/queues.md](../docs/primitives/queues.md). Type regression: `src/types-regression-tests/13_queues.ts`.

Highlights:

- `defineQueue` (data-only: `message`, optional `errors`, `defaultDelay`, `defaultTtl`).
- `ctx.queues.<slot>.enqueue` — buffered, `void`, `delay`/`ttl`/`priority`.
- `client.queues.<definitionName>.registerHandler` — required `retryPolicy` with `maxAttempts: number | null`; optional async `retentionPolicy`.
- `throw ctx.errors.<Code>(..., { deadLetter })` — workflow-style error map on the queue definition.
- Dead-letter namespace/handle APIs with `attempts()`.

## Runtime Target

- Persist `eligible_at` / `expires_at` at enqueue commit; numeric `ttl` offsets from eligibility.
- Queue message + attempt tables; `SELECT … FOR UPDATE SKIP LOCKED` claim ordering.
- Handler attempt records: declared errors persist `code` + `message`; schema codes add `details` with `serialization_error` degradation.
- `retentionPolicy` at finalize: `await policy(ctx)` → persist `retention_deadline_at`; sweeper GC.

## Affected Areas

- Queue definition and client modules.
- `src/types/definitions/messaging.ts`, `handlers.ts`, `results.ts`, `engine.ts`
- Migrations and queue worker runtime.

## Acceptance Contract

`src/types-regression-tests/13_queues.ts` verifies definition inference, `HasDefaultTtl` / `HasQueueErrors`, workflow enqueue typing, client handler registration, `ctx.errors` factory typing, `retentionPolicy` / `QueueRetentionContext`, dead-letter namespace/handle typing, and session-first placement on operator IO.
